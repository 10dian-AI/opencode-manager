#!/usr/bin/env python3
"""OpenCode Go 取消自动续费 —— 纯 HTTP 协议模块（独立模块，不依赖 main.py）。

协议链路（2026-08 逆向）:
  1. auth cookie + workspace_id
     → POST https://opencode.ai/_server (SolidJS server-fn)
     → 响应内嵌 Stripe billing portal URL (billing.stripe.com/p/session?secret=live_...)
  2. GET portal URL
     → HTML 里提取 session_api_key (ek_live_...) 和 bps_ session id
  3. GET /v1/billing_portal/sessions/{bps}/subscriptions
     → cancel_at_period_end 状态查询
  4. POST /v1/billing_portal/sessions/{bps}/subscriptions/{sub}/cancel?include_only[]=id
     body: refund=false
     → 取消自动续费（保留当前账期，服务到期后终止）

用法:
  python cancel_autorenew.py --username xxx        # 读 cookies/auth_cookies_xxx.json
  python cancel_autorenew.py --cookie-file xx.json # 指定 cookie 文件
  python cancel_autorenew.py --username xxx --status   # 只查状态不取消
  python cancel_autorenew.py --username xxx --resume   # 恢复自动续费（不取消订阅）
"""

import argparse
import glob
import gzip
import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

COOKIES_DIR = os.environ.get("OPENCODE_COOKIES_DIR", "cookies")
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)
# opencode.ai 部署版本的 server-fn id（来自浏览器抓包，同版本全局一致）
SERVER_ID = "62ed095777d5415e71394df8ceda4f1141f0ecd5e330f484e4eb5dcfc5b0f1df"
STRIPE_VERSION = "2025-06-30.basil"


class ProtocolError(Exception):
    """协议执行失败。"""


def _read_body(resp):
    body = resp.read()
    if resp.headers.get("Content-Encoding") == "gzip":
        body = gzip.decompress(body)
    return body.decode("utf-8", errors="replace")


def load_cookie_data(cookie_file):
    with open(cookie_file, "r", encoding="utf-8") as handle:
        return json.load(handle)


def auth_value(cookie_data):
    return next(
        (
            str(c.get("value", ""))
            for c in (cookie_data or {}).get("cookies", [])
            if c.get("name") == "auth" and c.get("value")
        ),
        "",
    )


def workspace_id_from(cookie_data):
    url = str((cookie_data or {}).get("url", ""))
    match = re.search(r"/workspace/(wrk_[A-Za-z0-9]+)", url)
    return match.group(1) if match else ""


def fetch_go_page(auth, workspace_id, timeout=20):
    """GET go 页面（用于校验 cookie 登录态 + 拿 liteSubscriptionID）。"""
    go_url = f"https://opencode.ai/workspace/{workspace_id}/go"
    request = urllib.request.Request(
        f"{go_url}?_={time.time_ns()}",
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
            "Cookie": f"auth={auth}",
            "Accept-Encoding": "gzip",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            body = _read_body(resp)
            final_url = resp.geturl()
    except urllib.error.HTTPError as exc:
        raise ProtocolError(f"go 页面请求失败 HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ProtocolError(f"go 页面请求失败: {exc}") from exc

    if "/workspace/" not in final_url.lower():
        raise ProtocolError("cookie 已失效（被重定向到登录页）")

    sub_id = re.search(r'liteSubscriptionID:"(sub_[^"]+)"', body)
    subscribed = "You are subscribed to OpenCode Go" in body
    return {
        "subscribed": subscribed,
        "lite_subscription_id": sub_id.group(1) if sub_id else "",
        "body": body,
    }


def create_portal_session(auth, workspace_id, timeout=20):
    """POST /_server 创建 Stripe billing portal session，返回 portal URL。"""
    go_url = f"https://opencode.ai/workspace/{workspace_id}/go"
    payload = {
        "t": {
            "t": 9,
            "i": 0,
            "l": 2,
            "a": [
                {"t": 1, "s": workspace_id},
                {"t": 1, "s": go_url},
            ],
            "o": 0,
        },
        "f": 31,
        "m": [],
    }
    request = urllib.request.Request(
        "https://opencode.ai/_server",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
            "Origin": "https://opencode.ai",
            "Referer": go_url,
            "X-Server-Id": SERVER_ID,
            "X-Server-Instance": "server-fn:0",
            "X-Single-Flight": "true",
            "Cookie": f"auth={auth}",
            "Accept": "*/*",
            "Accept-Encoding": "gzip",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            text = _read_body(resp)
    except urllib.error.HTTPError as exc:
        raise ProtocolError(f"portal session 创建失败 HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ProtocolError(f"portal session 创建失败: {exc}") from exc

    match = re.search(r'data:"(https://billing\.stripe\.com[^"]+)"', text)
    if not match:
        # server-fn 响应里可能是 error
        err = re.search(r'error:\{[^}]*"', text)
        raise ProtocolError(
            "portal URL 提取失败" + (f"（响应含 error: {err.group(0)[:80]}）" if err else "")
        )
    return match.group(1)


def parse_portal_page(portal_url, timeout=20):
    """GET portal HTML，提取 ek_live token 和 bps session id。"""
    request = urllib.request.Request(
        portal_url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html",
            "Accept-Encoding": "gzip",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            page = _read_body(resp)
    except urllib.error.HTTPError as exc:
        raise ProtocolError(f"portal 页面请求失败 HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ProtocolError(f"portal 页面请求失败: {exc}") from exc

    # token 可能是 HTML 实体编码（&quot;）包着，正则直接匹配原文即可
    token = re.search(r"ek_live_[A-Za-z0-9_]+", page)
    bps = re.search(r"bps_[A-Za-z0-9]+", page)
    account = re.search(r"acct_[A-Za-z0-9]+", page)
    if not token or not bps:
        raise ProtocolError("portal 页面里未找到 ek_live token 或 bps session id")
    return {
        "token": token.group(0),
        "bps_id": bps.group(0),
        "stripe_account": account.group(0) if account else "acct_1RszBH2StuRr0lbX",
        "portal_url": portal_url,
    }


def _stripe_headers(session, referer, extra=None):
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Authorization": f"Bearer {session['token']}",
        "Stripe-Account": session["stripe_account"],
        "Stripe-Livemode": "true",
        "Stripe-Version": STRIPE_VERSION,
        "Referer": referer,
        "X-Requested-With": "XMLHttpRequest",
        "x-stripe-csrf-token": "fake-deprecated-token",
    }
    if extra:
        headers.update(extra)
    return headers


def get_subscription(session, timeout=20):
    """查询订阅状态（含 cancel_at_period_end）。"""
    url = (
        f"https://billing.stripe.com/v1/billing_portal/sessions/"
        f"{session['bps_id']}/subscriptions?limit=3"
    )
    request = urllib.request.Request(
        url,
        headers=_stripe_headers(session, session["portal_url"]),
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            data = json.loads(_read_body(resp))
    except urllib.error.HTTPError as exc:
        raise ProtocolError(f"订阅状态查询失败 HTTP {exc.code}: {exc.read()[:200]}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ProtocolError(f"订阅状态查询失败: {exc}") from exc

    subs = data.get("data") or []
    if not subs:
        return None
    # 取第一个（OpenCode Go 单订阅）
    sub = subs[0]
    return {
        "id": sub.get("id"),
        "status": sub.get("status"),
        "cancel_at_period_end": bool(sub.get("cancel_at_period_end")),
        "cancel_at": sub.get("cancel_at"),
        "current_period_end": sub.get("current_period_end"),
    }


def cancel_subscription(session, sub_id, timeout=20):
    """取消自动续费（保留当前账期）。"""
    url = (
        f"https://billing.stripe.com/v1/billing_portal/sessions/"
        f"{session['bps_id']}/subscriptions/{sub_id}/cancel?include_only[]=id"
    )
    request = urllib.request.Request(
        url,
        data=b"refund=false",
        method="POST",
        headers=_stripe_headers(
            session,
            session["portal_url"],
            {
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": "https://billing.stripe.com",
                "X-Request-Source": (
                    'service="customer_portal"; project="customer_portal"; '
                    'operation="CancelSubscriptionPageCancelSubscriptionStateMutation"; '
                    'component="CancelSubscriptionPage"'
                ),
            },
        ),
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            body = _read_body(resp)
            status = resp.status
    except urllib.error.HTTPError as exc:
        raise ProtocolError(
            f"取消订阅失败 HTTP {exc.code}: {exc.read()[:300]}"
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ProtocolError(f"取消订阅失败: {exc}") from exc

    if status != 200:
        raise ProtocolError(f"取消订阅返回 HTTP {status}")
    try:
        result = json.loads(body)
    except json.JSONDecodeError:
        result = {"raw": body[:200]}
    return result


def resume_subscription(session, sub_id, timeout=20):
    """恢复自动续费（取消"取消"）。

    浏览器抓包确认: POST .../subscriptions/{sub_id}/reactivate （空 body，
    长长的 expand/include_only 查询参数只是响应字段裁剪，非必需）。
    """
    url = (
        f"https://billing.stripe.com/v1/billing_portal/sessions/"
        f"{session['bps_id']}/subscriptions/{sub_id}/reactivate?include_only[]=id"
    )
    request = urllib.request.Request(
        url,
        data=b"",
        method="POST",
        headers=_stripe_headers(
            session,
            session["portal_url"],
            {
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": "https://billing.stripe.com",
                "X-Request-Source": (
                    'service="customer_portal"; project="customer_portal"; '
                    'operation="ReactivateSubscriptionPageReactivateSubscriptionMutation"; '
                    'component="ReactivateSubscriptionPage"'
                ),
            },
        ),
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            body = _read_body(resp)
            status = resp.status
    except urllib.error.HTTPError as exc:
        raise ProtocolError(
            f"恢复订阅失败 HTTP {exc.code}: {exc.read()[:300]}"
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ProtocolError(f"恢复订阅失败: {exc}") from exc

    if status != 200:
        raise ProtocolError(f"恢复订阅返回 HTTP {status}")
    try:
        result = json.loads(body)
    except json.JSONDecodeError:
        result = {"raw": body[:200]}
    return result


def run(cookie_file, action="cancel", verify=True, timeout=20):
    """执行完整协议流程。action: status | cancel | resume。

    返回 dict:
      success, action, message, subscription{...}, portal_url
    """
    result = {
        "success": False,
        "action": action,
        "message": "",
        "subscription": None,
        "portal_url": "",
        "already_cancelled": False,
    }

    cookie_data = load_cookie_data(cookie_file) if isinstance(cookie_file, (str, bytes, os.PathLike)) else cookie_file
    auth = auth_value(cookie_data)
    workspace = workspace_id_from(cookie_data)
    if not auth or not workspace:
        result["message"] = "cookie 文件缺少 auth 或 workspace url"
        return result

    # 步骤 0: 校验登录态（顺便拿本地记录的订阅 ID）
    try:
        go_info = fetch_go_page(auth, workspace, timeout)
    except ProtocolError as exc:
        result["message"] = str(exc)
        return result
    if not go_info["subscribed"]:
        result["message"] = "该账号未订阅 OpenCode Go（go 页面无订阅状态）"
        return result

    # 步骤 1: 创建 portal session
    try:
        portal_url = create_portal_session(auth, workspace, timeout)
    except ProtocolError as exc:
        result["message"] = str(exc)
        return result
    result["portal_url"] = portal_url

    # 步骤 2: 解析 portal 页面拿 token
    try:
        session = parse_portal_page(portal_url, timeout)
    except ProtocolError as exc:
        result["message"] = str(exc)
        return result

    # 步骤 3: 查询订阅状态
    try:
        sub = get_subscription(session, timeout)
    except ProtocolError as exc:
        result["message"] = str(exc)
        return result
    if sub is None:
        result["message"] = "portal 里没有订阅记录"
        return result
    result["subscription"] = sub

    if action == "status":
        result["success"] = True
        result["message"] = (
            f"订阅 {sub['id']} 状态 {sub['status']}，"
            f"自动续费{'已取消' if sub['cancel_at_period_end'] else '开启中'}"
        )
        return result

    if action == "cancel":
        if sub["cancel_at_period_end"]:
            result["already_cancelled"] = True
            result["success"] = True
            result["message"] = "自动续费已是取消状态（幂等，无需操作）"
            return result
        try:
            cancel_subscription(session, sub["id"], timeout)
        except ProtocolError as exc:
            result["message"] = str(exc)
            return result
    elif action == "resume":
        if not sub["cancel_at_period_end"]:
            result["success"] = True
            result["message"] = "自动续费本是开启状态（幂等，无需操作）"
            return result
        try:
            resume_subscription(session, sub["id"], timeout)
        except ProtocolError as exc:
            result["message"] = str(exc)
            return result
    else:
        result["message"] = f"未知 action: {action}"
        return result

    # 步骤 4: 复查确认
    if verify:
        try:
            time.sleep(1)
            after = get_subscription(session, timeout)
        except ProtocolError as exc:
            result["message"] = f"操作已提交但复查失败: {exc}"
            result["success"] = False
            return result
        if after:
            result["subscription"] = after
            want = action == "cancel"
            if after["cancel_at_period_end"] == want:
                result["success"] = True
                result["message"] = (
                    f"{'已取消自动续费' if want else '已恢复自动续费'}"
                    f"（订阅 {after['id']}，到期时间戳 {after['current_period_end']}）"
                )
                return result
        result["message"] = "操作已提交但状态未变化，建议稍后复查"
        return result

    result["success"] = True
    result["message"] = f"{action} 请求已提交"
    return result


def main():
    parser = argparse.ArgumentParser(description="OpenCode Go 取消自动续费（纯 HTTP 协议）")
    parser.add_argument("--username", help="读取 cookies/auth_cookies_<用户名>.json")
    parser.add_argument("--cookie-file", help="直接指定 cookie JSON 文件")
    parser.add_argument("--all", action="store_true", help="批量处理 cookies/ 下所有 cookie 文件")
    parser.add_argument(
        "--action",
        choices=("status", "cancel", "resume"),
        default="cancel",
        help="status=只查状态, cancel=取消自动续费(默认), resume=恢复自动续费",
    )
    parser.add_argument("--timeout", type=int, default=20)
    parser.add_argument(
        "--stdin",
        action="store_true",
        help="从 stdin 读取 JSON（auth/auth_cookie + workspace_id 或完整 cookie_data），结果以 JSON 输出",
    )
    args = parser.parse_args()

    if args.stdin:
        try:
            payload = json.load(sys.stdin)
            if not isinstance(payload, dict):
                raise ValueError("stdin JSON 必须是对象")
            if payload.get("cookies"):
                cookie_data = payload
            else:
                auth = str(payload.get("auth") or payload.get("auth_cookie") or "")
                workspace = str(payload.get("workspace_id") or payload.get("workspace") or "")
                if not auth or not workspace:
                    raise ValueError("stdin JSON 缺少 auth/auth_cookie 或 workspace_id")
                cookie_data = {
                    "url": f"https://opencode.ai/workspace/{workspace}/go",
                    "cookies": [{"name": "auth", "value": auth}],
                }
            result = run(cookie_data, action=args.action, timeout=args.timeout)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            result = {
                "success": False,
                "action": args.action,
                "message": f"stdin JSON 读取失败: {exc}",
                "subscription": None,
                "portal_url": "",
                "already_cancelled": False,
            }
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("success") else 1

    if args.all:
        paths = sorted(glob.glob(os.path.join(COOKIES_DIR, "auth_cookies_*.json")))
        if not paths:
            print(f"[失败] {COOKIES_DIR} 下没有 auth_cookies_*.json")
            return 1
        ok = fail = skip = 0
        for path in paths:
            name = os.path.basename(path)
            result = run(path, action=args.action, timeout=args.timeout)
            label = "成功" if result["success"] else "失败"
            print(f"[{label}] {name}: {result['message']}")
            if result["success"]:
                ok += 1
            elif "未订阅" in result["message"] or "已是取消状态" in result["message"]:
                skip += 1
            else:
                fail += 1
        print(f"\n批量完成: 成功={ok} 失败={fail} 跳过={skip} 共={len(paths)}")
        return 0 if fail == 0 else 1

    cookie_file = args.cookie_file
    if not cookie_file and args.username:
        cookie_file = os.path.join(COOKIES_DIR, f"auth_cookies_{args.username}.json")
    if not cookie_file:
        parser.error("请提供 --username、--cookie-file 或 --all")
    if not os.path.exists(cookie_file):
        print(f"[失败] Cookie 文件不存在: {cookie_file}")
        return 1

    result = run(cookie_file, action=args.action, timeout=args.timeout)
    label = "成功" if result["success"] else "失败"
    print(f"[{label}] {result['message']}")
    if result.get("subscription"):
        print(f"  订阅详情: {json.dumps(result['subscription'], ensure_ascii=False)}")
    return 0 if result["success"] else 1


if __name__ == "__main__":
    sys.exit(main())


