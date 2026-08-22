/**
 * Best-effort region detection from proxy node names. Airport nodes almost
 * always carry a flag emoji or a region keyword (香港 / HK / Japan ...), which
 * is enough for "就近切换" — accounts are moved to a same-region node first.
 */

const KEYWORD_REGIONS: Array<[RegExp, string]> = [
  [/香港|hong\s?kong|\bHK\b|HKIA/i, 'HK'],
  [/台湾|taiwan|\bTW\b|taipei/i, 'TW'],
  [/日本|japan|\bJP\b|tokyo|osaka/i, 'JP'],
  [/新加坡|singapore|\bSG\b/i, 'SG'],
  [/韩国|korea|\bKR\b|seoul/i, 'KR'],
  [/美国|united\s?states|\bUS\b|\bUSA\b|america|los\s?angeles|san\s?jose|silicon/i, 'US'],
  [/英国|united\s?kingdom|\bUK\b|\bGB\b|london/i, 'GB'],
  [/德国|germany|\bDE\b|frankfurt/i, 'DE'],
  [/法国|france|\bFR\b|paris/i, 'FR'],
  [/荷兰|netherlands|\bNL\b|amsterdam/i, 'NL'],
  [/加拿大|canada|\bCA\b|toronto/i, 'CA'],
  [/澳大利亚|australia|\bAU\b|sydney/i, 'AU'],
  [/印度|india|\bIN\b|mumbai/i, 'IN'],
  [/土耳其|turkey|türkiye|\bTR\b|istanbul/i, 'TR'],
  [/俄罗斯|russia|\bRU\b|moscow/i, 'RU'],
  [/巴西|brazil|\bBR\b|sao\s?paulo/i, 'BR'],
  [/马来西亚|malaysia|\bMY\b|kuala/i, 'MY'],
  [/泰国|thailand|\bTH\b|bangkok/i, 'TH'],
  [/越南|vietnam|\bVN\b|hanoi|ho\s?chi\s?minh/i, 'VN'],
  [/菲律宾|philippines|\bPH\b|manila/i, 'PH'],
  [/印尼|印度尼西亚|indonesia|\bID\b|jakarta/i, 'ID'],
  [/意大利|italy|\bIT\b|milan/i, 'IT'],
  [/西班牙|spain|\bES\b|madrid/i, 'ES'],
  [/瑞士|switzerland|\bCH\b|zurich/i, 'CH'],
  [/瑞典|sweden|\bSE\b|stockholm/i, 'SE'],
  [/波兰|poland|\bPL\b|warsaw/i, 'PL'],
  [/阿联酋|迪拜|dubai|\bAE\b|uae/i, 'AE'],
  [/阿根廷|argentina|\bAR\b|buenos/i, 'AR'],
  [/墨西哥|mexico|\bMX\b/i, 'MX'],
  [/南非|south\s?africa|\bZA\b|johannesburg/i, 'ZA'],
  [/以色列|israel|\bIL\b/i, 'IL'],
  [/爱尔兰|ireland|\bIE\b|dublin/i, 'IE'],
  [/芬兰|finland|\bFI\b|helsinki/i, 'FI'],
  [/挪威|norway|\bNO\b|oslo/i, 'NO'],
  [/丹麦|denmark|\bDK\b|copenhagen/i, 'DK'],
  [/比利时|belgium|\bBE\b|brussels/i, 'BE'],
  [/奥地利|austria|\bAT\b|vienna/i, 'AT'],
  [/乌克兰|ukraine|\bUA\b|kyiv/i, 'UA'],
  [/罗马尼亚|romania|\bRO\b|bucharest/i, 'RO'],
  [/捷克|czech|\bCZ\b|prague/i, 'CZ'],
  [/匈牙利|hungary|\bHU\b|budapest/i, 'HU'],
  [/葡萄牙|portugal|\bPT\b|lisbon/i, 'PT'],
  [/希腊|greece|\bGR\b|athens/i, 'GR'],
  [/新西兰|new\s?zealand|\bNZ\b|auckland/i, 'NZ'],
  [/埃及|egypt|\bEG\b|cairo/i, 'EG'],
  [/沙特|saudi|\bSA\b|riyadh/i, 'SA'],
  [/巴基斯坦|pakistan|\bPK\b|karachi/i, 'PK'],
  [/澳门|macao|macau|\bMO\b/i, 'MO'],
  [/中国|大陆|china|\bCN\b|beijing|shanghai/i, 'CN']
]

function flagToRegion(name: string): string | null {
  // Regional indicator symbols: U+1F1E6..U+1F1FF map to A..Z.
  let pair = ''
  for (const char of name) {
    const code = char.codePointAt(0)!
    if (code < 0x1F1E6 || code > 0x1F1FF) {
      pair = ''
      continue
    }
    pair += String.fromCharCode(65 + code - 0x1F1E6)
    if (pair.length === 2) return pair
  }
  return null
}

export function detectRegion(name: string | null | undefined): string | null {
  if (!name) return null
  const flag = flagToRegion(name)
  if (flag) return flag
  for (const [pattern, region] of KEYWORD_REGIONS) {
    if (pattern.test(name)) return region
  }
  return null
}
