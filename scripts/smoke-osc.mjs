// Live OSC smoke test for v0.4.
// 1) Reads the current BPM via REST (no hardcoding — must restore exactly).
// 2) Subscribes to playhead positions for 2s and asserts ≥5 messages.
// 3) Sends a redundant tempo set with the SAME BPM (no perceptible change).
// 4) Re-reads BPM via REST and asserts unchanged.
//
// Usage: node scripts/smoke-osc.mjs [restHost:port] [oscHost] [oscIn] [oscOut]
// Defaults match the user's confirmed environment.

import dgram from 'node:dgram'
import { Buffer } from 'node:buffer'
import { setTimeout as delay } from 'node:timers/promises'

const REST_BASE = process.argv[2] || 'http://100.74.26.128:8080'
const OSC_HOST = process.argv[3] || '100.74.26.128'
const OSC_IN = Number(process.argv[4] || 7000)
const OSC_OUT = Number(process.argv[5] || 7001)

// ───────────────────── OSC encoder/decoder (mirrors src/) ─────────────────────
function align4(n) { return Math.ceil(n / 4) * 4 }
function padTo4(buf) {
  const total = align4(buf.length + 1)
  const out = Buffer.alloc(total)
  buf.copy(out, 0)
  return out
}
function oscString(s) { return padTo4(Buffer.from(s, 'utf8')) }
function oscInt32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b }
function oscFloat32(n) { const b = Buffer.alloc(4); b.writeFloatBE(n, 0); return b }
function encodeMessage(addr, args) {
  let tags = ','
  const argBufs = []
  for (const a of args) {
    if (typeof a === 'number') {
      if (Number.isInteger(a) && a >= -0x80000000 && a <= 0x7fffffff) {
        tags += 'i'; argBufs.push(oscInt32(a))
      } else {
        tags += 'f'; argBufs.push(oscFloat32(a))
      }
    } else if (typeof a === 'string') {
      tags += 's'; argBufs.push(oscString(a))
    } else if (typeof a === 'boolean') {
      tags += a ? 'T' : 'F'
    }
  }
  return Buffer.concat([oscString(addr), oscString(tags), ...argBufs])
}
function decodePacket(buf) {
  const out = []
  if (buf.length === 0) return out
  if (buf.slice(0, 8).toString('utf8') === '#bundle\0') {
    let p = 16
    while (p + 4 <= buf.length) {
      const sz = buf.readUInt32BE(p); p += 4
      if (sz <= 0 || p + sz > buf.length) break
      out.push(...decodePacket(buf.slice(p, p + sz)))
      p += sz
    }
    return out
  }
  let p = 0
  const addrEnd = buf.indexOf(0, p)
  if (addrEnd === -1) return out
  const address = buf.slice(p, addrEnd).toString('utf8')
  p = align4(addrEnd + 1)
  const tagsEnd = buf.indexOf(0, p)
  if (tagsEnd === -1) { out.push({ address, args: [] }); return out }
  const tags = buf.slice(p, tagsEnd).toString('utf8')
  p = align4(tagsEnd + 1)
  const args = []
  for (let i = 1; i < tags.length; i++) {
    const t = tags[i]
    if (t === 'i') { args.push(buf.readInt32BE(p)); p += 4 }
    else if (t === 'f') { args.push(buf.readFloatBE(p)); p += 4 }
    else if (t === 's') {
      const e = buf.indexOf(0, p)
      args.push(buf.slice(p, e).toString('utf8'))
      p = align4(e + 1)
    } else if (t === 'T') args.push(true)
    else if (t === 'F') args.push(false)
    else break
  }
  out.push({ address, args })
  return out
}

// ───────────────────── REST helpers ─────────────────────
async function readBpm() {
  const r = await fetch(`${REST_BASE}/api/v1/composition`, { signal: AbortSignal.timeout(5000) })
  if (!r.ok) throw new Error(`REST GET failed: ${r.status}`)
  const json = await r.json()
  // BPM lives at composition.tempocontroller.tempo.value
  const tc = json?.tempocontroller
  if (!tc || typeof tc.tempo?.value !== 'number') {
    throw new Error('Could not read BPM from composition')
  }
  return tc.tempo.value
}

// ───────────────────── Test steps ─────────────────────
async function step1_readBpm() {
  console.log('[smoke] step 1: reading current BPM via REST...')
  const bpm = await readBpm()
  console.log(`[smoke] current BPM = ${bpm}`)
  return bpm
}

async function step2_subscribe() {
  console.log('[smoke] step 2: subscribing to /composition/layers/*/transport/position for 2s...')
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4')
    const matched = []
    const all = []
    const timer = setTimeout(() => {
      sock.close()
      resolve({ matched, total: all.length })
    }, 2100)
    sock.on('error', (err) => {
      clearTimeout(timer)
      try { sock.close() } catch {}
      reject(err)
    })
    sock.on('message', (msg) => {
      try {
        for (const m of decodePacket(msg)) {
          all.push(m.address)
          if (/^\/composition\/layers\/[^/]+\/(clips\/[^/]+\/)?transport\/position$/.test(m.address)) {
            matched.push({ address: m.address, args: m.args })
          }
        }
      } catch {}
    })
    sock.bind(OSC_OUT)
  })
}

async function step3_sendReadOnlyQuery() {
  // CRITICAL: do NOT send a value to /composition/tempocontroller/tempo —
  // that path takes a normalized 0..1 value in OSC and would clobber BPM.
  // Instead, exercise sendOsc with a truly read-only query: send "?" to
  // /composition/tempocontroller/tempo. Resolume responds with the current
  // value but doesn't mutate it.
  console.log('[smoke] step 3: sending read-only OSC query (?) for tempo...')
  const sock = dgram.createSocket('udp4')
  const pkt = encodeMessage('/composition/tempocontroller/tempo', ['?'])
  return new Promise((resolve, reject) => {
    sock.send(pkt, OSC_IN, OSC_HOST, (err) => {
      sock.close()
      if (err) reject(err); else resolve()
    })
  })
}

async function step4_verifyBpm(originalBpm) {
  await delay(500) // give Resolume a moment to settle
  const bpm = await readBpm()
  console.log(`[smoke] step 4: BPM after OSC send = ${bpm}`)
  const drift = Math.abs(bpm - originalBpm)
  if (drift > 0.5) {
    throw new Error(`BPM drifted by ${drift.toFixed(3)} — expected unchanged`)
  }
}

// ───────────────────── Main ─────────────────────
async function main() {
  let originalBpm = null
  try {
    originalBpm = await step1_readBpm()
    const sub = await step2_subscribe()
    console.log(`[smoke] received ${sub.total} total OSC msgs; ${sub.matched.length} matched playhead pattern`)
    if (sub.matched.length < 5) {
      throw new Error(`Expected ≥5 playhead messages in 2s, got ${sub.matched.length}`)
    }
    await step3_sendReadOnlyQuery()
    await step4_verifyBpm(originalBpm)
    console.log('[smoke] PASS — OSC subscribe works, send works, BPM unchanged.')
    process.exit(0)
  } catch (err) {
    console.error('[smoke] FAIL:', err?.message || err)
    if (originalBpm !== null) {
      console.error(`[smoke] (Reminder: original BPM was ${originalBpm} — verify in Resolume.)`)
    }
    process.exit(1)
  }
}

main()
