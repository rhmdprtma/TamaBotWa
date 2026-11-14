// plugins/mctama/imgkt.js
// FITUR .imgkt - Bikin meme kata-kata kayak "lah gua mah mantep."
// Cara pake:
// 1. Reply foto + .imgkt lah gua mah mantep.
// 2. Langsung .imgkt gua paling ganteng se Pontianak (pake pp)

const Jimp = require('jimp')
const fetch = require('node-fetch')

let handler = async (m, { conn, args, quoted, text }) => {
  try {
    let teks = text || args.join(' ')
    if (!teks) return m.reply(`*Cara pake nya bung!*\n\nReply foto terus ketik:\n*.imgkt lah gua mah mantep.*\n\nAtau langsung:\n*.imgkt gua paling ganteng*\n\nTerserah lu mau req kata apa!`)

    await m.reply('⏳ *Tama lagi ngedit foto lu bung... bentar!*')

    // 1. AMBIL FOTO
    let bufferFoto
    let q = quoted || m.quoted
    if (q && (q.mtype === 'imageMessage' || q.msg?.mimetype?.startsWith('image'))) {
      bufferFoto = await q.download()
    } else {
      // Kalo gak reply foto, pake foto profil pengirim
      try {
        let pp = await conn.profilePictureUrl(m.sender, 'image')
        let res = await fetch(pp)
        bufferFoto = Buffer.from(await res.arrayBuffer())
      } catch {
        return m.reply('Kirim foto dulu bung! Reply foto nya terus ketik .imgkt + kata-kata lu!')
      }
    }

    // 2. BIKIN CANVAS 1080x1080
    let W = 1080, H = 1080
    let canvas = new Jimp(W, H, '#87CEEB') // warna langit biru

    // Background rumput bawah - warna ijo
    let rumput = new Jimp(W, 350, '#5BBE3A')
    canvas.composite(rumput, 0, H - 350)

    // Awan putih biar mirip foto contoh
    let awan = new Jimp(400, 100, '#FFFFFF')
    awan.opacity(0.7)
    canvas.composite(awan, 100, 100)
    canvas.composite(awan, 600, 200)

    // 3. FOTO ORANG DI KANAN
    let foto = await Jimp.read(bufferFoto)
    foto.cover(620, 900) // potong jadi pas
    canvas.composite(foto, 480, 180)

    // 4. TEKS DI KIRI - GEDE, ITEM, KAYAK DI FOTO
    let font = await Jimp.loadFont(Jimp.FONT_SANS_128_BLACK)
    let fontKecil = await Jimp.loadFont(Jimp.FONT_SANS_64_BLACK)

    // Bagi teks jadi per baris, maks 10 huruf per baris biar mirip contoh
    let kata = teks.split(' ')
    let baris = []
    let temp = ''
    for (let k of kata) {
      if ((temp + ' ' + k).trim().length > 10) {
        baris.push(temp.trim())
        temp = k
      } else {
        temp = temp ? temp + ' ' + k : k
      }
    }
    if (temp) baris.push(temp.trim())

    // Kalo teks kepanjangan, kecilin font nya
    if (baris.length > 5) font = await Jimp.loadFont(Jimp.FONT_SANS_64_BLACK)

    let y = 320
    for (let b of baris) {
      canvas.print(font, 60, y, b)
      y += 145
    }
    // Tambahin titik di akhir kalo belum ada, biar mirip "mantep."
    if (!teks.trim().endsWith('.')) {
      // gak usah, biarin aja
    }

    let hasil = await canvas.getBufferAsync(Jimp.MIME_JPEG)

    // 5. KIRIM HASIL
    await conn.sendMessage(m.chat, {
      image: hasil,
      caption: `*Berhasil bung!* 🔥\nTeks: ${teks}\n\n_Bikin lagi: .imgkt + kata-kata lu_`
    }, { quoted: m })

  } catch (e) {
    console.log(e)
    m.reply('Waduh gagal bung! Coba kirim foto dulu, terus reply pake .imgkt + kata-kata nya!')
  }
}

handler.help = ['imgkt <teks>']
handler.tags = ['mctama']
handler.command = /^(imgkt)$/i

module.exports = handler
