#!/usr/bin/env python3
"""使用已保存的 auth Cookie，通过纯 HTTP 协议开启国内模型。"""

import argparse
import html.parser
import http.cookiejar
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


COOKIES_DIR = os.environ.get("OPENCODE_COOKIES_DIR", "cookies")
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "Chrome/125.0.0.0 Safari/537.36"
)


class ChinaModelFormParser(html.parser.HTMLParser):
    """从 Go 页面提取包含 useChinaProviders 的表单。"""

    def __init__(self):
        super().__init__()
        self.current_form = None
        self.form = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "form":
            self.current_form = {"attrs": attrs, "inputs": []}
        elif tag == "input" and self.current_form is not None:
            self.current_form["inputs"].append(attrs)

    def handle_endtag(self, tag):
        if tag != "form" or self.current_form is None:
            return
        if any(
            item.get("name") == "useChinaProviders"
            for item in self.current_form["inputs"]
        ):
            self.form = self.current_form
        self.current_form = None


def auth_cookie_value(cookie_data):
    return next(
        (
            str(cookie.get("value", ""))
            for cookie in (cookie_data or {}).get("cookies", [])
            if cookie.get("name") == "auth" and cookie.get("value")
        ),
        "",
    )


def workspace_go_url(cookie_data):
    current_url = str((cookie_data or {}).get("url", ""))
    match = re.search(
        r"^(https?://[^/]+/workspace/[^/?#]+)",
        current_url,
        flags=re.IGNORECASE,
    )
    return match.group(1).rstrip("/") + "/go" if match else ""


def build_opener(auth_value, go_url):
    hostname = urllib.parse.urlsplit(go_url).hostname or "opencode.ai"
    jar = http.cookiejar.CookieJar()
    jar.set_cookie(http.cookiejar.Cookie(
        version=0,
        name="auth",
        value=auth_value,
        port=None,
        port_specified=False,
        domain=hostname,
        domain_specified=True,
        domain_initial_dot=False,
        path="/",
        path_specified=True,
        secure=go_url.startswith("https://"),
        expires=None,
        discard=True,
        comment=None,
        comment_url=None,
        rest={"HttpOnly": None},
        rfc2109=False,
    ))
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(jar),
        urllib.request.HTTPSHandler(context=context),
    )


def fetch_china_model_form(opener, go_url, timeout):
    request = urllib.request.Request(
        f"{go_url}?protocol={time.time_ns()}",
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
            "Cache-Control": "no-cache",
        },
    )
    with opener.open(request, timeout=timeout) as response:
        body = response.read().decode("utf-8", errors="replace")
        final_url = response.geturl()
    parser = ChinaModelFormParser()
    parser.feed(body)
    if parser.form is None or "/workspace/" not in final_url.lower():
        return None
    return parser.form


def form_values(form):
    return {
        item.get("name"): item.get("value", "")
        for item in form["inputs"]
        if item.get("name")
    }


def set_china_models_http(cookie_data, enabled=True, timeout=30):
    """把国内模型设置为目标状态；已是目标状态时不提交。"""
    auth_value = auth_cookie_value(cookie_data)
    go_url = workspace_go_url(cookie_data)
    if not auth_value or not go_url:
        return {"success": False, "message": "Cookie 或 workspace 地址无效"}

    opener = build_opener(auth_value, go_url)
    request_timeout = max(1, min(int(timeout), 20))
    try:
        form = fetch_china_model_form(opener, go_url, request_timeout)
        if form is None:
            return {"success": False, "message": "Cookie 登录失败或未找到国内模型设置"}

        values = form_values(form)
        current_value = str(values.get("useChinaProviders", "")).lower()
        target_value = "true" if enabled else "false"
        if current_value == target_value:
            return {
                "success": True,
                "enabled": enabled,
                "already_in_target": True,
                "already_enabled": enabled,
                "message": f"国内模型已经{'开启' if enabled else '关闭'}",
            }
        if current_value not in {"true", "false"}:
            return {"success": False, "message": "无法识别国内模型当前状态"}

        action_query = urllib.parse.parse_qs(
            urllib.parse.urlsplit(form["attrs"].get("action", "")).query
        )
        action_id = (action_query.get("id") or [""])[0]
        workspace_id = str(values.get("workspaceID", ""))
        if not action_id or not workspace_id:
            return {"success": False, "message": "表单缺少动作 ID 或 workspaceID"}

        origin_parts = urllib.parse.urlsplit(go_url)
        origin = f"{origin_parts.scheme}://{origin_parts.netloc}"
        payload = urllib.parse.urlencode({
            "workspaceID": workspace_id,
            # 此动作接收当前状态并执行 toggle，而不是接收目标状态。
            "useChinaProviders": current_value,
        }).encode("utf-8")
        request = urllib.request.Request(
            urllib.parse.urljoin(origin, "/_server"),
            data=payload,
            method="POST",
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "*/*",
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": origin,
                "Referer": go_url,
                "X-Server-Id": action_id,
                "X-Server-Instance": "server-fn:0",
                "X-Single-Flight": "true",
            },
        )
        with opener.open(request, timeout=request_timeout) as response:
            response.read()
            if response.status != 200:
                return {"success": False, "message": f"协议请求返回 HTTP {response.status}"}

        deadline = time.time() + max(1, int(timeout))
        while time.time() < deadline:
            form = fetch_china_model_form(opener, go_url, request_timeout)
            if form is not None:
                values = form_values(form)
                if str(values.get("useChinaProviders", "")).lower() == target_value:
                    return {
                        "success": True,
                        "enabled": enabled,
                        "already_in_target": False,
                        "already_enabled": enabled,
                        "message": f"已通过 HTTP {'开启' if enabled else '关闭'}国内模型",
                    }
            time.sleep(1)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        return {"success": False, "message": f"HTTP 操作失败: {exc}"}

    return {
        "success": False,
        "message": f"提交后未确认国内模型已{'开启' if enabled else '关闭'}",
    }


def enable_china_models_http(cookie_data, timeout=30):
    """兼容原有调用：幂等开启国内模型。"""
    return set_china_models_http(cookie_data, enabled=True, timeout=timeout)


def main():
    parser = argparse.ArgumentParser(description="用 Cookie 通过 HTTP 开启或关闭国内模型")
    parser.add_argument("--username", help="读取 cookies/auth_cookies_<用户名>.json")
    parser.add_argument("--cookie-file", help="直接指定 Cookie JSON 文件")
    parser.add_argument(
        "--stdin",
        action="store_true",
        help="从 stdin 读取 JSON 格式的 cookie_data，结果以 JSON 输出到 stdout",
    )
    parser.add_argument(
        "--disable",
        action="store_true",
        help="将国内模型关闭；默认行为是开启",
    )
    parser.add_argument("--timeout", type=int, default=30, help="等待确认秒数，默认 30")
    args = parser.parse_args()

    if args.stdin:
        try:
            cookie_data = json.load(sys.stdin)
        except (OSError, json.JSONDecodeError) as exc:
            print(
                json.dumps(
                    {"success": False, "message": f"stdin JSON 读取失败: {exc}"},
                    ensure_ascii=False,
                )
            )
            return 1
        result = set_china_models_http(
            cookie_data,
            enabled=not args.disable,
            timeout=args.timeout,
        )
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("success") else 1

    cookie_file = args.cookie_file
    if not cookie_file and args.username:
        cookie_file = os.path.join(COOKIES_DIR, f"auth_cookies_{args.username}.json")
    if not cookie_file:
        parser.error("请提供 --username、--cookie-file 或 --stdin")
    if not os.path.exists(cookie_file):
        print(f"[失败] Cookie 文件不存在: {cookie_file}")
        return 1

    try:
        with open(cookie_file, "r", encoding="utf-8") as handle:
            cookie_data = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[失败] Cookie 文件读取失败: {exc}")
        return 1

    result = set_china_models_http(
        cookie_data,
        enabled=not args.disable,
        timeout=args.timeout,
    )
    label = "成功" if result.get("success") else "失败"
    print(f"[{label}] {result.get('message', '未知结果')}")
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
