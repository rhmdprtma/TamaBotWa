import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { exec } from 'child_process'
import util from 'util'
const execAsync = util.promisify(exec)

import { proto, downloadContentFromMessage } from '@whiskeysockets/baileys'
import config from '../../config.js'

let ffmpegBin = 'ffmpeg'
try {
  const installer = (await import('@ffmpeg-installer/ffmpeg')).default
  if (installer.path) ffmpegBin = installer.path
} catch {}

let ffprobeBin = 'ffprobe'
try {
  const ffprobeInstaller = (await import('@ffprobe-installer/ffprobe')).default
  if (ffprobeInstaller.path) ffprobeBin = ffprobeInstaller.path
} catch {}

const MAX_DURATION = 60
const MAX_FILE_SIZE = 16 * 1024 * 1024

// === PATCH PROTO BIAR JADI AUDIO STICKER BENERAN (TAG 210 & 1074) ===
function patchProtoInstance(p) {
  const M = p?.Message
  if (!M || M.__audioStickerPatchedV3) return
  if (M.StickerMessage) {
    const prev = M.StickerMessage.encode
    M.StickerMessage.encode = function (message, writer) {
      const audio = message?.audioMessage
      if (audio && Object.prototype.hasOwnProperty.call(message, 'audioMessage')) delete message.audioMessage
      const w = prev.call(this, message, writer)
      if (audio && M.AudioMessage) {
        message.audioMessage = audio
        M.AudioMessage.encode(audio, w.uint32(210).fork()).ldelim()
      }
      return w
    }
  }
  const prevMsgEncode = M.encode
  M.encode = function (message, writer) {
    const asm = message?.audioStickerMessage
    if (asm) {
      if (Object.prototype.hasOwnProperty.call(message, 'stickerMessage')) delete message.stickerMessage
      if (Object.prototype.hasOwnProperty.call(message, 'audioStickerMessage')) delete message.audioStickerMessage
    }
    const w = prevMsgEncode.call(this, message, writer)
    if (asm && M.FutureProofMessage) {
      message.audioStickerMessage = asm
      M.FutureProofMessage.encode(asm, w.uint32(1074).fork()).ldelim()
    }
    return w
  }
  M.__audioStickerPatchedV3 = true
}

function generateWaveform(buffer) {
  const bars = 64
  const result = new Uint8Array(bars)
  if (!buffer || buffer.length === 0) {
    for (let i = 0; i < bars; i++) result[i] = Math.floor(Math.random() * 80) + 20
    return result
  }
  const step = Math.max(1, Math.floor(buffer.length / bars))
  for (let i = 0; i < bars; i++) {
    let sum = 0
    const start = i * step
    const end = Math.min(start + step, buffer.length)
    for (let j = start; j < end; j++) sum += Math.abs(buffer[j] - 128)
    const avg = sum / (end - start || 1)
    result[i] = Math.min(100, Math.max(10, Math.floor((avg / 128) * 100)))
  }
  return result
}

function buildSoundStickerSvg(durationStr) {
  return `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#1e1e2f"/><stop offset="100%" stop-color="#11111b"/></linearGradient><linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#89b4fa"/><stop offset="100%" stop-color="#cba6f7"/></linearGradient></defs>
  <rect x="24" y="24" width="464" height="464" rx="120" fill="url(#bg)" stroke="#313244" stroke-width="8"/>
  <circle cx="256" cy="210" r="90" fill="url(#accent)" opacity="0.15"/><circle cx="256" cy="210" r="70" fill="url(#accent)"/>
  <path d="M 235 180 L 210 195 L 185 195 L 185 225 L 210 225 L 235 240 Z" fill="#11111b"/>
  <path d="M 250 190 Q 265 210 250 230" stroke="#11111b" stroke-width="6" stroke-linecap="round" fill="none"/>
  <path d="M 262 178 Q 285 210 262 242" stroke="#11111b" stroke-width="6" stroke-linecap="round" fill="none"/>
  <text x="256" y="465" font-family="sans-serif" font-size="28" font-weight="bold" fill="#cdd6f4" text-anchor="middle">AUDIO STICKER • ${durationStr}</text></svg>`
}

let handler = async (m, { conn, text, usedPrefix, command, RaplyGwe }) => {
  // Deteksi quoted audio / video - pake format TamaBotWa
  let quoted = m.quoted
  let isQuotedVideo = quoted && (quoted.isVideo || /video/i.test(quoted.mimetype || ''))
  let isMsgVideo = m.isVideo || /video/i.test(m.mimetype || '')
  let isVideoInput = isQuotedVideo || isMsgVideo

  let isQuotedAudio = quoted && (quoted.isAudio || /audio|ogg|opus|mpeg|mp3|wav|m4a|aac/i.test(quoted.mimetype || ''))
  let isMsgAudio = m.isAudio || /audio|ogg|opus|mpeg|mp3|wav|m4a|aac/i.test(m.mimetype || '')
  let isAudioInput = isQuotedAudio || isMsgAudio

  if (!isVideoInput && !isAudioInput) {
    return RaplyGwe(`🎵 *AUDIO STICKER*\n\nReply VN / Audio / Video dengan *${usedPrefix + command}*\n\nContoh:\n• Reply VN > *${usedPrefix}audiosticker*\n• Kirim audio dengan caption *${usedPrefix}audiosticker Pack | Author*\n\nMax: ${MAX_DURATION} detik, 16 MB`)
  }

  await m.react('⏳')
  if (proto) patchProtoInstance(proto)

  let tempDir = path.join(process.cwd(), 'storage', 'temp')
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true })
  let id = crypto.randomBytes(6).toString('hex')
  let inputFile = path.join(tempDir, `astk_in_${id}.bin`)
  let outputOgg = path.join(tempDir, `astk_out_${id}.ogg`)
  let outputWebp = path.join(tempDir, `astk_${id}.webp`)

  try {
    let target = isVideoInput ? (isQuotedVideo ? quoted : m) : (isQuotedAudio ? quoted : m)
    let mediaBuffer = null

    // Download pake cara TamaBotWa (m.download / quoted.download)
    if (typeof target.download === 'function') {
      try { mediaBuffer = await target.download() } catch {}
    }
    if (!mediaBuffer) {
      // Fallback Baileys
      let mediaObj = target.msg || target.message
      if (mediaObj) {
        let kind = isVideoInput ? 'video' : 'audio'
        let stream = await downloadContentFromMessage(mediaObj, kind)
        let chunks = []
        for await (const chunk of stream) chunks.push(chunk)
        mediaBuffer = Buffer.concat(chunks)
      }
    }
    if (!mediaBuffer || mediaBuffer.length === 0) throw new Error('Gagal download media')
    if (mediaBuffer.length > MAX_FILE_SIZE) throw new Error(`File kegedean ${(mediaBuffer.length/1024/1024).toFixed(1)} MB, max 16 MB`)

    fs.writeFileSync(inputFile, mediaBuffer)

    let durationSec = 0
    try {
      let { stdout } = await execAsync(`"${ffprobeBin}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputFile}"`)
      durationSec = parseFloat(stdout.trim()) || 0
    } catch {}
    if (durationSec > MAX_DURATION) throw new Error(`Durasi ${Math.round(durationSec)} detik, max ${MAX_DURATION} detik`)

    // Convert ke OGG Opus
    if (isVideoInput) {
      await execAsync(`"${ffmpegBin}" -y -i "${inputFile}" -vn -map 0:a:0 -t ${MAX_DURATION} -c:a libopus -b:a 64k -ar 48000 -ac 1 "${outputOgg}"`)
    } else {
      await execAsync(`"${ffmpegBin}" -y -i "${inputFile}" -vn -c:a libopus -b:a 64k -ar 48000 -ac 1 "${outputOgg}"`)
    }

    let oggBuffer = fs.readFileSync(outputOgg)
    let waveform = generateWaveform(oggBuffer)

    // Packname - SAMAIN KAYA brat.js LU
    let packname = global.stickpack || global.namebot || config.botName || 'TamaBotWa'
    let author = global.stickauth || global.author || config.ownerName || 'Tama'
    if (text && text.includes('|')) {
      let parts = text.split('|').map(s => s.trim())
      if (parts[0]) packname = parts[0]
      if (parts[1]) author = parts[1]
    } else if (text) packname = text.trim()

    // Bikin stiker visual SVG -> WebP
    const sharp = (await import('sharp')).default
    let durLabel = durationSec > 0 ? `${Math.round(durationSec)}s` : 'VN'
    await sharp(Buffer.from(buildSoundStickerSvg(durLabel)))
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 90 }).toFile(outputWebp)
    let stickerWithExif = fs.readFileSync(outputWebp)

    // Coba kirim sebagai AUDIO STICKER beneran
    let sent = false
    try {
      // Upload manual pake conn.waUploadToServer kalo ada, kalo gak fallback
      if (conn.waUploadToServer) {
        const { prepareWAMessageMedia } = await import('@whiskeysockets/baileys')
        let finalSec = Math.max(1, Math.min(MAX_DURATION, Math.round(durationSec || 5)))
        let prepAudio = await prepareWAMessageMedia({ audio: oggBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { upload: conn.waUploadToServer })
        let audioMessage = prepAudio?.audioMessage
        if (audioMessage) {
          audioMessage.ptt = true
          audioMessage.mimetype = 'audio/ogg; codecs=opus'
          audioMessage.seconds = finalSec
          audioMessage.waveform = waveform
        }
        let prepSticker = await prepareWAMessageMedia({ sticker: stickerWithExif }, { upload: conn.waUploadToServer })
        if (prepSticker?.stickerMessage && audioMessage) {
          prepSticker.stickerMessage.audioMessage = audioMessage
          let payload = { __proto__: prepSticker, audioStickerMessage: { message: prepSticker }, messageContextInfo: { messageSecret: crypto.randomBytes(32) } }
          await conn.relayMessage(m.chat, payload, {})
          sent = true
        }
      }
    } catch (e) { console.error('[audiosticker relay]', e.message) }

    if (!sent) {
      // Fallback ala brat.js - kirim stiker + VN, tetep jalan
      await conn.sendSticker(m.chat, stickerWithExif, m, { packname, author })
      await conn.sendMessage(m.chat, { audio: oggBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true, waveform }, { quoted: m })
    }

    await m.react('✅')
  } catch (e) {
    console.error('[audiosticker]', e)
    await m.react('❌')
    await RaplyGwe(`Gagal bikin audio sticker.\n\n${e.message}`.slice(0, 600))
  } finally {
    try {
      if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile)
      if (fs.existsSync(outputOgg)) fs.unlinkSync(outputOgg)
      if (fs.existsSync(outputWebp)) fs.unlinkSync(outputWebp)
    } catch {}
  }
}

handler.help = ['audiosticker <reply audio/video>']
handler.tags = ['sticker']
handler.command = /^(audiosticker|stikeraudio|soundsticker|saudio|asticker)$/i

export default handler
