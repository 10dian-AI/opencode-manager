import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes
} from 'node:crypto'
import net, { type Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { encodeTunnelAddress } from './tunnel-address'
import { abortReason, type TunnelConnect } from './tunnel-fetch'
import { wrapTargetTls } from './socks-fetch'

const CONNECT_TIMEOUT_MS = 10_000
const TAG_LENGTH = 16
const MAX_PAYLOAD = 0x3FFF
const SUBKEY_INFO = Buffer.from('ss-subkey', 'ascii')

interface CipherSpec {
  nodeName: string
  keyLength: number
  nonceLength: number
}

const CIPHERS: Record<string, CipherSpec> = {
  'aes-128-gcm': { nodeName: 'aes-128-gcm', keyLength: 16, nonceLength: 12 },
  'aes-256-gcm': { nodeName: 'aes-256-gcm', keyLength: 32, nonceLength: 12 },
  'chacha20-ietf-poly1305': { nodeName: 'chacha20-poly1305', keyLength: 32, nonceLength: 12 }
}

export function isSupportedShadowsocksCipher(method: string) {
  return method.toLowerCase() in CIPHERS
}

/** OpenSSL EVP_BytesToKey (MD5, no salt, single iteration) used by Shadowsocks. */
export function evpBytesToKey(password: string, keyLength: number): Buffer {
  const passwordBytes = Buffer.from(password, 'utf8')
  const blocks: Buffer[] = []
  let previous = Buffer.alloc(0)
  let length = 0
  while (length < keyLength) {
    previous = createHash('md5').update(previous).update(passwordBytes).digest()
    blocks.push(previous)
    length += previous.length
  }
  return Buffer.concat(blocks).subarray(0, keyLength)
}

/** RFC 5869 HKDF-SHA1, as used for Shadowsocks AEAD subkey derivation. */
export function hkdfSha1(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha1', salt).update(ikm).digest()
  const blocks: Buffer[] = []
  let previous = Buffer.alloc(0)
  let counter = 1
  let produced = 0
  while (produced < length) {
    previous = createHmac('sha1', prk)
      .update(previous)
      .update(info)
      .update(Buffer.from([counter++]))
      .digest()
    blocks.push(previous)
    produced += previous.length
  }
  return Buffer.concat(blocks).subarray(0, length)
}

export interface ShadowsocksConfig {
  host: string
  port: number
  method: string
  password: string
}

function decodeCredential(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Parses the canonical internal form `ss://method:password@host:port`
 * (credentials percent-encoded). Subscription wire formats are normalized to
 * this form by subscription.ts.
 */
export function parseShadowsocksUrl(uri: string): ShadowsocksConfig {
  const url = new URL(uri)
  if (url.protocol !== 'ss:') throw new Error('Not a Shadowsocks URL')
  const method = decodeCredential(url.username)
  const password = decodeCredential(url.password)
  const spec = CIPHERS[method.toLowerCase()]
  if (!spec) throw new Error(`Unsupported Shadowsocks cipher: ${method}`)
  if (!url.hostname || !url.port) throw new Error('Shadowsocks host and port are required')
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: Number(url.port),
    method: method.toLowerCase(),
    password
  }
}

class AeadCipher {
  private nonce = 0
  constructor(
    private readonly spec: CipherSpec,
    private readonly subkey: Buffer
  ) {}

  private nextNonce() {
    const nonce = Buffer.alloc(this.spec.nonceLength)
    // Little-endian counter, per Shadowsocks AEAD spec.
    nonce.writeUIntLE(this.nonce, 0, Math.min(6, this.spec.nonceLength))
    if (this.nonce >= Number.MAX_SAFE_INTEGER) throw new Error('Nonce exhausted')
    this.nonce += 1
    return nonce
  }

  encrypt(plaintext: Buffer): Buffer {
    const cipher = createCipheriv(
      this.spec.nodeName as 'aes-128-gcm',
      this.subkey,
      this.nextNonce(),
      { authTagLength: TAG_LENGTH }
    )
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  }

  decrypt(ciphertext: Buffer): Buffer {
    if (ciphertext.length < TAG_LENGTH) throw new Error('Ciphertext shorter than AEAD tag')
    const decipher = createDecipheriv(
      this.spec.nodeName as 'aes-128-gcm',
      this.subkey,
      this.nextNonce(),
      { authTagLength: TAG_LENGTH }
    )
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LENGTH))
    return Buffer.concat([
      decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_LENGTH)),
      decipher.final()
    ])
  }
}

/** A Duplex that transparently encrypts/decrypts Shadowsocks AEAD chunks. */
class ShadowsocksStream extends Duplex {
  private recvBuffer = Buffer.alloc(0)
  private recvCipher: AeadCipher | null = null
  private pendingLength: number | null = null

  constructor(
    private readonly raw: Socket,
    private readonly spec: CipherSpec,
    private readonly sendCipher: AeadCipher,
    private readonly masterKey: Buffer
  ) {
    super({ allowHalfOpen: false })
    raw.on('data', chunk => this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    raw.once('error', error => this.destroy(error))
    raw.once('close', () => {
      if (!this.readableEnded) this.push(null)
      if (!this.destroyed) this.destroy()
    })
  }

  private consume(chunk: Buffer) {
    if (this.destroyed) return
    this.recvBuffer = Buffer.concat([this.recvBuffer, chunk])
    try {
      if (this.recvCipher === null) {
        if (this.recvBuffer.length < this.spec.keyLength) return
        const salt = this.recvBuffer.subarray(0, this.spec.keyLength)
        this.recvBuffer = this.recvBuffer.subarray(this.spec.keyLength)
        this.recvCipher = new AeadCipher(
          this.spec,
          hkdfSha1(this.masterKey, salt, SUBKEY_INFO, this.spec.keyLength)
        )
      }
      while (true) {
        if (this.pendingLength === null) {
          const headerSize = 2 + TAG_LENGTH
          if (this.recvBuffer.length < headerSize) return
          const lengthBytes = this.recvCipher.decrypt(this.recvBuffer.subarray(0, headerSize))
          this.recvBuffer = this.recvBuffer.subarray(headerSize)
          this.pendingLength = lengthBytes.readUInt16BE(0)
        }
        if (this.recvBuffer.length < this.pendingLength + TAG_LENGTH) return
        const payload = this.recvCipher.decrypt(
          this.recvBuffer.subarray(0, this.pendingLength + TAG_LENGTH)
        )
        this.recvBuffer = this.recvBuffer.subarray(this.pendingLength + TAG_LENGTH)
        this.pendingLength = null
        if (payload.length && !this.push(payload)) {
          this.raw.pause()
        }
      }
    } catch (error) {
      this.destroy(error instanceof Error ? error : new Error(String(error)))
    }
  }

  override _read() {
    this.raw.resume()
  }

  private encryptPayload(payload: Buffer) {
    const length = Buffer.alloc(2)
    length.writeUInt16BE(payload.length)
    this.raw.write(Buffer.concat([
      this.sendCipher.encrypt(length),
      this.sendCipher.encrypt(payload)
    ]))
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    try {
      for (let offset = 0; offset < chunk.length; offset += MAX_PAYLOAD) {
        this.encryptPayload(chunk.subarray(offset, Math.min(offset + MAX_PAYLOAD, chunk.length)))
      }
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }

  override _final(callback: (error?: Error | null) => void) {
    this.raw.end()
    callback()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.raw.destroy()
    callback(error)
  }
}

export function createShadowsocksConnect(uri: string): TunnelConnect {
  const config = parseShadowsocksUrl(uri)
  const spec = CIPHERS[config.method]!
  const masterKey = evpBytesToKey(config.password, spec.keyLength)

  return async (url, signal) => {
    if (signal.aborted) throw abortReason(signal)

    const raw = await new Promise<Socket>((resolve, reject) => {
      const socket = net.connect({
        host: config.host,
        port: config.port,
        timeout: CONNECT_TIMEOUT_MS
      })
      let settled = false
      const onAbort = () => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(abortReason(signal))
      }
      socket.once('connect', () => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        socket.setNoDelay()
        resolve(socket)
      })
      socket.once('timeout', () => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        socket.destroy()
        reject(new Error(`Shadowsocks server ${config.host}:${config.port} connect timed out`))
      })
      socket.once('error', (error) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      })
      signal.addEventListener('abort', onAbort, { once: true })
    })

    // Client handshake: salt, then the encrypted target address chunk.
    const salt = randomBytes(spec.keyLength)
    const sendCipher = new AeadCipher(
      spec,
      hkdfSha1(masterKey, salt, SUBKEY_INFO, spec.keyLength)
    )
    const stream = new ShadowsocksStream(raw, spec, sendCipher, masterKey)
    raw.write(salt)
    stream.write(encodeTunnelAddress(
      url.hostname,
      Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
    ))

    if (url.protocol !== 'https:') return stream as unknown as Socket
    return wrapTargetTls(stream as unknown as Socket, url, signal)
  }
}
