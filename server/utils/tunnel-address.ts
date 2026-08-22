import net from 'node:net'

/**
 * SOCKS5-style address block used by Shadowsocks and Trojan:
 * ATYP (1 byte) + address + port (2 bytes, big endian).
 */
export function encodeTunnelAddress(hostname: string, port: number): Buffer {
  const host = hostname.replace(/^\[(.*)\]$/, '$1')
  if (net.isIPv4(host)) {
    return Buffer.concat([
      Buffer.from([0x01]),
      Buffer.from(host.split('.').map(part => Number(part))),
      uint16(port)
    ])
  }
  if (net.isIPv6(host)) {
    return Buffer.concat([
      Buffer.from([0x04]),
      parseIpv6(host),
      uint16(port)
    ])
  }
  const name = Buffer.from(host, 'utf8')
  if (name.length > 255) throw new Error(`Target host name is too long: ${host}`)
  return Buffer.concat([
    Buffer.from([0x03, name.length]),
    name,
    uint16(port)
  ])
}

function uint16(value: number) {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16BE(value)
  return buffer
}

function parseIpv6(address: string): Buffer {
  const [headPart, tailPart] = address.split('::')
  const head = headPart ? headPart.split(':').filter(Boolean) : []
  const tail = tailPart ? tailPart.split(':').filter(Boolean) : []
  const groups: number[] = []
  for (const group of head) groups.push(parseInt(group, 16))
  if (address.includes('::')) {
    const missing = 8 - head.length - tail.length
    for (let i = 0; i < missing; i++) groups.push(0)
  }
  for (const group of tail) groups.push(parseInt(group, 16))
  if (groups.length !== 8 || groups.some(group => !Number.isFinite(group) || group < 0 || group > 0xFFFF)) {
    throw new Error(`Invalid IPv6 address: ${address}`)
  }
  const buffer = Buffer.alloc(16)
  groups.forEach((group, index) => buffer.writeUInt16BE(group, index * 2))
  return buffer
}

/** Decodes a SOCKS5-style address block; returns bytes consumed. */
export function decodeTunnelAddress(buffer: Buffer, offset = 0): { host: string; port: number; length: number } {
  const atyp = buffer[offset]
  let host: string
  let cursor = offset + 1
  if (atyp === 0x01) {
    host = [...buffer.subarray(cursor, cursor + 4)].join('.')
    cursor += 4
  } else if (atyp === 0x03) {
    const length = buffer[cursor]!
    host = buffer.subarray(cursor + 1, cursor + 1 + length).toString('utf8')
    cursor += 1 + length
  } else if (atyp === 0x04) {
    const groups: string[] = []
    for (let i = 0; i < 8; i++) groups.push(buffer.readUInt16BE(cursor + i * 2).toString(16))
    host = groups.join(':')
    cursor += 16
  } else {
    throw new Error(`Unknown address type ${atyp}`)
  }
  const port = buffer.readUInt16BE(cursor)
  return { host, port, length: cursor + 2 - offset }
}
