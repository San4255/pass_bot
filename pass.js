// ============================================================
// WhatsApp Bot - Baileys (CONNECTION-ONLY VERSION)
//
// FLOW:
// 1) WhatsApp se connect karta hai, connect hone ke baad bas
//    connected rehta hai (koi HTTP listener nahi, koi message
//    send karne wala code nahi)
// 2) "node bot.js jid" - sabhi groups aur (jitne mil paaye)
//    channels ka naam + JID print karke exit ho jaata hai
// 3) "node bot.js channel <invite_link_ya_code>" - ek specific
//    channel ka naam + JID nikaalta hai uske invite link/code se
//    (yeh channel-discovery ka sabse reliable tarika hai, kyunki
//    Baileys mein "saare followed channels" list karne ki koi
//    guaranteed API nahi hai)
// 4) watched.json (config file) auto-create ho jaati hai agar
//    exist nahi karti - usmein tum manually un groups/channels
//    ke JID daaloge jinke message par nazar rakhni hai
// ============================================================

const { default: makeWASocket,
        useMultiFileAuthState,
        DisconnectReason,
        generateForwardMessageContent,
        generateWAMessageFromContent
      } = require('@whiskeysockets/baileys')

const qrcode = require('qrcode-terminal')
const pino = require('pino')
const fs = require('fs')
const path = require('path')
const https = require('https')

// ============ CONFIG ============
const AUTH_DIR = './auth_info'
const WATCHED_FILE = path.join(__dirname, 'watched.json')

const USERS_FILE = path.join(__dirname, 'users.json')
const MAX_USERS = 5                    // users.json mein isse zyada ho to bhi sirf pehle 5 chalenge
const REDEEM_DELAY_MS = 2 * 1000      // redeem request se pehle 30 second ka wait
const HISTORY_REDEEM_WINDOW_MS = 10 * 60 * 1000   // reconnect ke turant baad backlog mein aaya message itna purana tak ho to bhi redeem chalega (isse purana ho to ignore)
const HISTORY_FORWARD_WINDOW_MS = 5 * 1000       // reconnect ke turant baad backlog mein aaya message itna purana tak ho to forward bhi hoga (isse purana ho to forward nahi hoga)

const API_BASE = 'https://api.pasfirstai.com/index.php/api'
const API_HEADERS = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
    'content-type': 'application/x-www-form-urlencoded',
    'origin': 'https://pasfirstai.com',
    'referer': 'https://pasfirstai.com/',
    'sec-ch-ua': '"Chromium";v="137", "Not/A)Brand";v="24"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36'
}

const LIST_MODE    = process.argv[2] === 'jid'
const CHANNEL_MODE = process.argv[2] === 'channel'
const CHANNEL_ARG  = process.argv[3]   // invite link ya sirf invite code
// ================================

let hasEverConnected = false
let connectAttempts  = 0


// ------------------------------------------------------------
// silenceNoise(): Baileys/libsignal ke internal warnings
// ("Decrypted message with closed session" jaise) seedha console
// pe print hote hain aur humara actual result scroll karke upar
// chala jaata hai. Yeh function un patterns ko temporarily hide
// kar deta hai - humara apna console.log isse affect nahi hota
// kyunki hum use restore hone ke baad call karte hain.
// ------------------------------------------------------------
function silenceNoise() {
    const noisyPatterns = [
        /Decrypted message with closed session/i,
        /Closing (open |stale )?session/i,
        /Failed to decrypt message/i,
        /SessionError/i,
        /No matching sessions found/i,
        /Bad MAC/i
    ]

    const origLog   = console.log.bind(console)
    const origError = console.error.bind(console)
    const origWarn  = console.warn.bind(console)

    const wrap = (orig) => (...args) => {
        const text = args.map(a => (typeof a === 'string' ? a : '')).join(' ')
        if (noisyPatterns.some(p => p.test(text))) return
        orig(...args)
    }

    console.log   = wrap(origLog)
    console.error = wrap(origError)
    console.warn  = wrap(origWarn)

    return function restore() {
        console.log   = origLog
        console.error = origError
        console.warn  = origWarn
    }
}


// ------------------------------------------------------------
// checkInternet(): Android jaisa hi connectivity check
// ------------------------------------------------------------
function checkInternet() {
    const https = require('https')
    return new Promise((resolve) => {
        const req = https.get('https://clients3.google.com/generate_204', { timeout: 5000 }, (res) => {
            res.resume()
            resolve(true)
        })
        req.on('timeout', () => { req.destroy(); resolve(false) })
        req.on('error', () => resolve(false))
    })
}


// ------------------------------------------------------------
// ensureWatchedFile(): watched.json na ho to default template
// bana deta hai. Ismein groups/channels ke JID daale jaayenge
// jinke message par future mein nazar rakhni hai (regex-watcher
// wala part baad mein isi file ko padhega).
// ------------------------------------------------------------
function ensureWatchedFile() {
    if (fs.existsSync(WATCHED_FILE)) return

    const template = {
        _note: "JID formats: group = xxxx@g.us | channel = xxxx@newsletter | person = 91XXXXXXXXXX@s.whatsapp.net (country code ke saath, + ke bina). JID nikalne ke liye 'node bot.js jid' (groups) ya 'node bot.js channel <invite_link>' (channel) chalao.",
        notification_jid: "91XXXXXXXXXX@s.whatsapp.net",
        live_update_minutes: 30,
        groups: [],
        channels: [],
        persons: [],
        channel_names: {},
        forwards: [],
        trigger_regex: "\\b[0-9]{7,9}\\b",
        extract_regex: "[0-9]+"
    }

    fs.writeFileSync(WATCHED_FILE, JSON.stringify(template, null, 2))
    console.log(`📝 watched.json ban gayi -> ${WATCHED_FILE}`)
}


// ------------------------------------------------------------
// loadWatched(): watched.json padhta hai, saare JID ek Set mein
// ------------------------------------------------------------
function loadWatched() {
    const cfg = JSON.parse(fs.readFileSync(WATCHED_FILE, 'utf8'))
    const jids = new Set([
        ...(cfg.groups || []),
        ...(cfg.channels || []),
        ...(cfg.persons || [])
    ].filter(Boolean))

    // forwardMap: source JID -> [destination JID, ...] (jin source ke liye
    // forward set nahi hai unke liye kuch nahi milega, sirf redeem chalega)
    const forwardMap = new Map()
    for (const f of (cfg.forwards || [])) {
        if (!f || !f.from || !f.to) continue
        if (!forwardMap.has(f.from)) forwardMap.set(f.from, [])
        forwardMap.get(f.from).push(f.to)
    }

    // channelNames: channel JID -> uska naam (config.js ne invite link se
    // resolve karke pehle hi save kiya hota hai - forward ke waqt isliye
    // koi extra API call nahi karni padti, "View Channel" tab ke liye)
    const channelNames = new Map(Object.entries(cfg.channel_names || {}))

    return {
        jids,
        channels: (cfg.channels || []).filter(Boolean),
        notificationJid: cfg.notification_jid,
        liveMinutes: Number(cfg.live_update_minutes) || 0,   // khaali/0/galat value = live update band
        trigger: new RegExp(cfg.trigger_regex || '\\b[0-9]{7,9}\\b'),
        extract: new RegExp(cfg.extract_regex || '[0-9]+', 'g'),
        forwardMap,
        channelNames
    }
}


// ------------------------------------------------------------
// users.json: user, username, password, session, notify, verify_id
// (session aur verify_id script khud bharti hai)
// ------------------------------------------------------------
function ensureUsersFile() {
    if (fs.existsSync(USERS_FILE)) return
    // 5 khaali slots - jinme username/password khaali hai wo skip ho jaate hain
    const template = [1, 2, 3, 4, 5].map(n => ({
        user: `user${n}`, username: '', password: '', session: '', notify: '', update: '', verify_id: ''
    }))
    fs.writeFileSync(USERS_FILE, JSON.stringify(template, null, 2))
    console.log(`📝 users.json ban gayi -> ${USERS_FILE}`)
}

function loadUsers() {
    const all = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
    return { all, active: all.slice(0, MAX_USERS).filter(u => u && u.username && u.password) }
}

function saveUsers(all) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(all, null, 2))
}

// 23 digit ki id, '17' se shuru (13 digit timestamp + 10 random digit), har user ki alag
function makeVerifyId() {
    let rnd = ''
    for (let i = 0; i < 10; i++) rnd += Math.floor(Math.random() * 10)
    return String(Date.now()) + rnd
}

// ------------------------------------------------------------
// postForm(): form-urlencoded POST, JSON response wapas deta hai
// (URLSearchParams se password ke @ # jaise characters sahi encode hote hain)
// ------------------------------------------------------------
function postForm(endpoint, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams(params).toString()
        const u = new URL(API_BASE + endpoint)
        const req = https.request({
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: 'POST',
            headers: { ...API_HEADERS, 'content-length': Buffer.byteLength(body) },
            timeout: timeoutMs
        }, (res) => {
            let data = ''
            res.setEncoding('utf8')
            res.on('data', c => data += c)
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode}`))
                }
                try { resolve(JSON.parse(data)) }
                catch { reject(new Error('JSON nahi aaya: ' + data.slice(0, 100))) }
            })
        })
        req.on('timeout', () => req.destroy(new Error('timeout')))
        req.on('error', reject)
        req.write(body)
        req.end()
    })
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ------------------------------------------------------------
// postWithRetry(): SIRF tab dobara try karta hai jab server ka sahi jawab
// na aaye (timeout / connection error / HTTP 200 nahi / JSON nahi).
// Server ka sahi JSON jawab aa gaya (chahe "code exist nahi karta" ho) to
// wahi final hai - retry nahi hota.
// ------------------------------------------------------------
const RETRY_ATTEMPTS = 3
const RETRY_GAP_MS = 1000
const RETRY_TIMEOUT_MS = 8000

async function postWithRetry(endpoint, params, tag) {
    let lastErr
    for (let i = 1; i <= RETRY_ATTEMPTS; i++) {
        try {
            return await postForm(endpoint, params, RETRY_TIMEOUT_MS)
        } catch (err) {
            lastErr = err
            console.log(`${tag} ⚠️ attempt ${i}/${RETRY_ATTEMPTS} fail: ${err.message}`)
            if (i < RETRY_ATTEMPTS) await sleep(RETRY_GAP_MS)
        }
    }
    throw lastErr
}

// ------------------------------------------------------------
// prepareSession(): session ho to pehle loginhb se check (status 1 = valid),
// warna / expire ho gaya ho to login karke naya token user.session mein daalo.
// Return: true agar user ka session ab usable hai
// ------------------------------------------------------------
async function prepareSession(user) {
    const tag = `[${user.user || user.username}]`
    try {
        if (user.session) {
            const chk = await postForm('/index/loginhb', { is_external: 1, language: 'en-US', token: user.session })
            if (chk.status === 1) {
                console.log(`${tag} ✅ session valid`)
                return true
            }
            console.log(`${tag} ⚠️ session expire (status ${chk.status}) - login kar raha hoon`)
        }

        if (!user.verify_id) user.verify_id = makeVerifyId()

        const res = await postForm('/Login/login.html', {
            username: user.username,
            password: user.password,
            user_verify: '',
            verify_id: user.verify_id,
            smscode: 91,
            is_external: 1,
            language: 'en-US'
        })

        if (res.status === 1 && res.token) {
            user.session = res.token
            console.log(`${tag} ✅ login ho gaya, session update`)
            return true
        }
        console.log(`${tag} ❌ login fail: ${res.info}`)
        return false
    } catch (err) {
        console.log(`${tag} ❌ session/login error: ${err.message}`)
        return false
    }
}

// ------------------------------------------------------------
// extractLevelCodes(): message mein "level + code" ke jode dhundta hai
// (Q1:92921742 / Q1-78788889 / Q1 87837383 / Q1 ke neeche agle line mein code).
// Code sirf 7 se 9 digit ka, ek saath juda; 10+ digit wale number reject.
// Wapas { q1: '92921742', q2: '...' } deta hai (level lowercase mein).
// Koi jodi na mile to {} - tab purana simple (sabke liye ek code) logic chalta hai.
// ------------------------------------------------------------
function extractLevelCodes(text) {
    const re = /(?<![\p{L}\p{N}])([A-Za-z]{1,3}[0-9]{1,2})(?![\p{L}\p{N}])[^\p{L}\p{N}]{1,8}(?<![0-9])([0-9]{7,9})(?![0-9])/gu
    const levels = {}
    for (const m of text.matchAll(re)) {
        const k = m[1].toLowerCase()
        if (!(k in levels)) levels[k] = m[2]
    }
    return levels
}

// ------------------------------------------------------------
// buildNotifyText(): user ke notify wale message ka format -
// Date / Time / Code + (Price ya Info ya Error). Time India (IST) ka.
// ------------------------------------------------------------
function buildNotifyText(code, label, value) {
    const d = new Date()
    const date = d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-')
    const time = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hourCycle: 'h23' })
    return `Date: ${date}\nTime: ${time}\nCode: ${code}\n${label}: ${value}`
}

// ------------------------------------------------------------
// sendNotify(): kisi bhi JID par message bhejta hai. Group JID (@g.us) ho
// to bhejne ke baad 25 second ruk jaata hai (delivery properly hone ke
// liye) - person ke liye koi wait nahi. Isi function se dono - apne number
// wala notify aur users.json ka "update" JID - message bhejte hain.
// ------------------------------------------------------------
async function sendNotify(sock, jid, text, tag) {
    try {
        await sock.sendMessage(jid, { text })
        console.log(`${tag} 📩 notify bheja -> ${jid}`)
        if (jid.endsWith('@g.us')) {
            await sleep(25000)
        }
    } catch (err) {
        console.log(`${tag} ⚠️ notify fail (${jid}): ${err.message}`)
    }
}

// ------------------------------------------------------------
// redeemForUser(): code submit; price aaye tabhi success.
//  - notify=yes  -> apne (username) number par message
//  - update=<jid> -> us JID par bhi message (sirf price milne par)
// ------------------------------------------------------------
async function redeemForUser(sock, user, code) {
    const tag = `[${user.user || user.username}]`
    try {
        const res = await postWithRetry('/member/redeem', {
            code, is_external: 1, language: 'en-US', token: user.session
        }, tag)

        const price = res.data && res.data.price
        if (res.status === 1 && price) {
            console.log(`${tag} 🎉 SUCCESS price: ${price} (code ${code})`)
            const text = `${price}`

            if (String(user.notify).toLowerCase() === 'yes') {
                const num = user.username.length === 10 ? '91' + user.username : user.username
                await sendNotify(sock, `${num}@s.whatsapp.net`, buildNotifyText(code, 'Price', price), tag)
            }
            if (user.update) {
                await sendNotify(sock, user.update, text, tag)
            }
        } else {
            console.log(`${tag} ❌ redeem fail: ${res.info || 'unknown'} (code ${code})`)

            // Price nahi aaya - info sirf notify number par (update JID par nahi)
            if (String(user.notify).toLowerCase() === 'yes') {
                const num = user.username.length === 10 ? '91' + user.username : user.username
                await sendNotify(sock, `${num}@s.whatsapp.net`, buildNotifyText(code, 'Info', res.info || 'unknown'), tag)
            }
        }
    } catch (err) {
        console.log(`${tag} ❌ ${RETRY_ATTEMPTS} attempt ke baad bhi server se jawab nahi aaya: ${err.message}`)

        if (String(user.notify).toLowerCase() === 'yes') {
            const num = user.username.length === 10 ? '91' + user.username : user.username
            await sendNotify(sock, `${num}@s.whatsapp.net`, buildNotifyText(code, 'Error', `⚠️ Server issue - redeem nahi ho paya (${err.message})`), tag)
        }
    }
}

// ------------------------------------------------------------
// handleCode(): match hone par chalta hai.
// 30 sec ka timer turant shuru -> usi dauraan saare users ka session
// PARALLEL mein ready -> 30 sec poore hote hi saare users ka redeem PARALLEL.
// ------------------------------------------------------------
const CODE_COOLDOWN_MS = 5 * 60 * 60 * 1000   // same code 5 ghante tak dobara nahi chalega
const processedCodes = new Map()               // code -> last chalne ka time

function cooldownBlocked(code) {
    const lastRun = processedCodes.get(code)
    if (lastRun && Date.now() - lastRun < CODE_COOLDOWN_MS) {
        const leftMin = Math.ceil((CODE_COOLDOWN_MS - (Date.now() - lastRun)) / 60000)
        console.log(`↩️ Code ${code} abhi chala tha - skip (${leftMin} min baad phir chalega)`)
        return true
    }
    return false
}

// source: string (simple message - sabhi users ke liye ek hi code)
//      ya object { q1: code, q2: code } (level wala message - har user apne level ka code)
async function handleCode(sock, source) {
    const levelMode = source !== null && typeof source === 'object'

    if (!levelMode) {
        if (cooldownBlocked(source)) return
        processedCodes.set(source, Date.now())
    }

    // Purani (5 ghante se puraani) entries hata do taaki memory na badhe
    for (const [c, t] of processedCodes) {
        if (Date.now() - t >= CODE_COOLDOWN_MS) processedCodes.delete(c)
    }

    const { all, active } = loadUsers()
    if (active.length === 0) {
        console.log('⚠️ users.json mein koi valid user nahi (username/password chahiye)')
        return
    }

    // jobs: kis user ke liye kaunsa code
    let jobs
    if (levelMode) {
        jobs = []
        for (const u of active) {
            const lv = String(u.level || '').trim().toLowerCase()
            const code = lv && source[lv]
            if (!code) {
                console.log(`[${u.user || u.username}] ⚠️ level '${lv || '-'}' ka code message mein nahi mila - skip`)
                continue
            }
            if (cooldownBlocked(code)) continue
            jobs.push({ user: u, code })
        }
        if (jobs.length === 0) return
        for (const code of new Set(jobs.map(j => j.code))) processedCodes.set(code, Date.now())
    } else {
        jobs = active.map(u => ({ user: u, code: source }))
    }

    console.log(`\n🚀 ${levelMode ? 'Level wise codes' : `Code ${source}`} - ${jobs.length} user(s), ${REDEEM_DELAY_MS / 1000}s wait shuru`)
    const delay = sleep(REDEEM_DELAY_MS)

    const ready = await Promise.all(jobs.map(j => prepareSession(j.user)))
    saveUsers(all)   // naye session / verify_id file mein

    await delay

    await Promise.all(jobs.filter((_, i) => ready[i]).map(j => redeemForUser(sock, j.user, j.code)))
}


// ------------------------------------------------------------
// forwardMessage(): asli message ko forward karta hai.
//  - Group/person source: Baileys ka built-in forward (seedha, fast)
//  - Channel source: khud contextInfo banate hain taaki WhatsApp
//    "View Channel" tab + channel ka naam sahi dikhaye - Baileys ka
//    built-in forward (generateForwardMessageContent) yeh info discard
//    kar deta hai, isliye channel ke liye alag se banana padta hai.
//    Dono mein koi extra API call/wait nahi - serverMessageId seedha
//    original message se milta hai, naam pehle se watched.json mein
//    save hota hai (config.js jab channel add karta hai tabhi).
// ------------------------------------------------------------
async function forwardMessage(sock, destJid, msg, sourceJid, channelName) {
    try {
        if (!sourceJid.endsWith('@newsletter')) {
            await sock.sendMessage(destJid, { forward: msg, force: true })
            console.log(`↗️ Forward ho gaya -> ${destJid}`)
            return
        }

        const content = generateForwardMessageContent(msg, true)
        const key = Object.keys(content)[0]
        content[key].contextInfo = {
            ...content[key].contextInfo,
            forwardedNewsletterMessageInfo: {
                newsletterJid: sourceJid,
                newsletterName: channelName || '',
                serverMessageId: Number(msg.newsletterServerId) || 0,
                contentType: 1   // UPDATE - normal channel text/media post
            }
        }

        const fullMsg = generateWAMessageFromContent(destJid, content, {})
        await sock.relayMessage(destJid, fullMsg.message, { messageId: fullMsg.key.id })
        console.log(`↗️ Forward ho gaya (channel post) -> ${destJid}`)
    } catch (err) {
        console.log(`❌ Forward fail (${destJid}): ${err.message}`)
    }
}


// ------------------------------------------------------------
// startWatcher(): watched JID ke messages par nazar rakhta hai.
// trigger regex match ho to extract regex se final output print.
// ------------------------------------------------------------
async function startWatcher(sock) {
    let watched
    try {
        watched = loadWatched()
    } catch (err) {
        console.log('❌ watched.json padh nahi paya:', err.message)
        return
    }

    if (watched.jids.size === 0) {
        console.log('⚠️ watched.json mein koi JID nahi hai - pehle JID daalo')
        return
    }

    // Channels ke live messages ke liye subscribe karna padta hai
    for (const jid of watched.channels) {
        try {
            await sock.subscribeNewsletterUpdates(jid)
        } catch (err) {
            console.log(`⚠️ Channel subscribe fail (${jid}):`, err.message)
        }
    }

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        const isLive = type === 'notify'   // 'notify' = abhi live aaya message

        for (const msg of messages) {
            if (!msg.message) continue

            // Person ke liye kabhi @lid aata hai, isliye alt JID bhi check karte hain
            const candidates = [msg.key.remoteJid, msg.key.remoteJidAlt, msg.key.participantAlt]
            const matchedJid = candidates.find(j => j && watched.jids.has(j))
            if (!matchedJid) continue

            if (!isLive) {
                // Backlog/history-sync wala message (jaise reconnect ke turant
                // baad ka case: internet gaya, code aaya, wapas connect hua to
                // yeh message history mein aaya). HISTORY_REDEEM_WINDOW_MS se
                // zyada purana ho to bilkul ignore - bahut purana code chalne
                // se bachne ke liye.
                const msgTimeMs = Number(msg.messageTimestamp || 0) * 1000
                const ageMs = Date.now() - msgTimeMs
                if (!msgTimeMs || ageMs > HISTORY_REDEEM_WINDOW_MS) continue
            }

            const text = msg.message.conversation
                || msg.message.extendedTextMessage?.text
                || msg.message.imageMessage?.caption
                || ''
            if (!text || !watched.trigger.test(text)) continue

            const output = text.match(watched.extract) || []
            console.log(`\n🎯 MATCH (${matchedJid})${isLive ? '' : ' [history]'}`)
            console.log('   Message:', text)
            console.log('   Output :', output.join(', '))

            // Redeem history aur live dono ke liye chalta hai (time-window ke andar)
            // Level wala message (Q1 + code, Q2 + code...) ho to har user apne level ka code
            // lega; warna purana tarika - pehla match sabhi users ke liye
            const levelCodes = extractLevelCodes(text)
            if (Object.keys(levelCodes).length) {
                console.log('   Levels :', JSON.stringify(levelCodes))
                handleCode(sock, levelCodes).catch(err => console.log('❌ handleCode error:', err.message))
            } else if (output.length) {
                handleCode(sock, output[0]).catch(err => console.log('❌ handleCode error:', err.message))
            }

            // Forward: live message hamesha forward hota hai. History/backlog wala
            // message tabhi forward hoga jab HISTORY_FORWARD_WINDOW_MS ke andar ka ho
            const fwdMsgTimeMs = Number(msg.messageTimestamp || 0) * 1000
            const canForward = isLive || (fwdMsgTimeMs && (Date.now() - fwdMsgTimeMs) <= HISTORY_FORWARD_WINDOW_MS)
            if (canForward) {
                const destinations = watched.forwardMap.get(matchedJid)
                if (destinations) {
                    for (const dest of destinations) {
                        forwardMessage(sock, dest, msg, matchedJid, watched.channelNames.get(matchedJid)).catch(err => console.log('❌ forward error:', err.message))
                    }
                }
            }
        }
    })

    // Live update: har N minute par notification_jid ko "i'm live" bhejo
    if (watched.liveMinutes > 0 && watched.notificationJid) {
        setInterval(async () => {
            try {
                await sock.sendMessage(watched.notificationJid, { text: "i'm live" })
                console.log(`📡 Live update bheja -> ${watched.notificationJid}`)
            } catch (err) {
                console.log('⚠️ Live update bhejne mein error:', err.message)
            }
        }, watched.liveMinutes * 60 * 1000)
        console.log(`⏱️ Live update har ${watched.liveMinutes} minute par chalega`)
    }

    console.log(`👀 ${watched.jids.size} JID par nazar rakh raha hoon...`)
}


// ------------------------------------------------------------
// extractInviteCode(): "https://whatsapp.com/channel/XXXXXXXX"
// jaisa link ho ya sirf "XXXXXXXX" code - dono se code nikaal deta hai
// ------------------------------------------------------------
function extractInviteCode(input) {
    if (!input) return null
    const match = input.match(/channel\/([A-Za-z0-9]+)/)
    return match ? match[1] : input.trim()
}


// ------------------------------------------------------------
// resolveChannelByInvite(): Ek channel ka invite link/code de kar
// uska naam + JID nikaalta hai - "node bot.js channel <link>" mode
// ------------------------------------------------------------
async function resolveChannelByInvite(sock) {
    const restore = silenceNoise()
    const code = extractInviteCode(CHANNEL_ARG)

    let result = null
    let errorMsg = null

    if (!code) {
        errorMsg = 'Invite link ya code nahi diya. Usage: node bot.js channel <invite_link_ya_code>'
    } else {
        try {
            const meta = await sock.newsletterMetadata('invite', code)
            if (meta && meta.id) {
                // Baileys yahan raw server response deta hai - naam flat "name"
                // mein nahi, "thread_metadata.name.text" mein hota hai
                const name = meta.thread_metadata?.name?.text || meta.name || '(naam nahi mila)'
                result = `${name}  ->  ${meta.id}`
            } else {
                errorMsg = 'Channel nahi mila - link/code check karo.'
            }
        } catch (err) {
            errorMsg = `Error: ${err.message}`
        }
    }

    restore()

    console.log('\n=========== CHANNEL ===========')
    if (result) {
        console.log(result)
        console.log('\n✅ Ab is JID ko copy karke watched.json mein daal do.')
    } else {
        console.log(`❌ ${errorMsg}`)
    }

    process.exit(result ? 0 : 1)
}


// ------------------------------------------------------------
// listGroupsAndChannels(): Sirf "node bot.js jid" chalane par call
// hota hai. Poora output pehle collect karta hai aur SABSE AKHIR
// mein ek saath print karta hai, taaki koi bhi internal noise
// (jaise history-sync ke warnings) result ko upar scroll na kare.
// ------------------------------------------------------------
async function listGroupsAndChannels(sock) {
    const restore = silenceNoise()

    // ---- Groups ----
    let groupLines = []
    try {
        const groups = await sock.groupFetchAllParticipating()
        const groupList = Object.values(groups)
        groupLines = groupList.length === 0
            ? ['(Koi group nahi mila)']
            : groupList.map(g => `${g.subject}  ->  ${g.id}`)
    } catch (err) {
        groupLines = [`❌ Groups fetch karne mein error: ${err.message}`]
    }

    restore()

    // ---- Print ----
    console.log('\n============ GROUPS ============')
    groupLines.forEach(l => console.log(l))

    // Is Baileys version mein "saare followed channels list karo" jaisi
    // koi bulk API exist hi nahi karti (newsletter.d.ts confirm karta hai -
    // sirf per-jid/per-invite functions hain). Isliye har channel ke liye
    // invite link se resolve karna padega:
    console.log('\n=========== CHANNELS ===========')
    console.log("Is Baileys version mein channels ki bulk-list API nahi hai.")
    console.log("Har channel ke liye yeh chalao:")
    console.log("  node bot.js channel <channel_invite_link>")
    console.log("(Channel kholo -> Channel info -> Invite via link -> wahi link yahan paste karo)")

    console.log('\n✅ Groups ke JID upar se copy karke watched.json mein daal do.')
    process.exit(0)
}


// ------------------------------------------------------------
// handleInitialConnectionFailure(): Jab WhatsApp se connection
// pehli baar hi nahi ban paata (kabhi 'open' nahi hua)
// ------------------------------------------------------------
async function handleInitialConnectionFailure() {
    connectAttempts++
    console.log(`❌ Connection ban nahi payi (attempt ${connectAttempts})`)

    console.log('🌐 Internet check kar raha hoon...')
    const internetOk = await checkInternet()

    if (!internetOk) {
        console.log('❌ Internet hi nahi chal raha')
        process.exit(1)
    }

    console.log('✅ Internet chal raha hai')

    if (connectAttempts < 2) {
        console.log('🔄 Ek baar phir se connect karne ki koshish...')
        startBot()
    } else {
        console.log('❌ Internet hone ke bawajood connection nahi bana - koi aur issue hai')
        process.exit(1)
    }
}


// ------------------------------------------------------------
// startBot(): WhatsApp se connection banata hai aur bas
// connected rehta hai. LIST_MODE/CHANNEL_MODE mein result print
// karke exit ho jaata hai.
// ------------------------------------------------------------
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update

        if (qr) {
            console.log('📱 QR Code Scan Karo WhatsApp se:')
            qrcode.generate(qr, { small: true })
        }

        if (connection === 'close') {
            if (LIST_MODE || CHANNEL_MODE) return   // in modes mein reconnect ki zaroorat nahi

            if (hasEverConnected) {
                console.log('❌ Disconnected! Reconnecting...')
                startBot()
            } else {
                await handleInitialConnectionFailure()
            }
        }

        if (connection === 'open') {
            hasEverConnected = true
            connectAttempts = 0
            console.log('✅ WhatsApp Connected!')
            console.log('💬 This tool made by San4255 & My github page link : https://github.com/San4255')

            if (LIST_MODE) {
                await listGroupsAndChannels(sock)
            } else if (CHANNEL_MODE) {
                await resolveChannelByInvite(sock)
            } else {
                ensureWatchedFile()
                ensureUsersFile()
                await startWatcher(sock)
            }
        }
    })

    return sock
}

startBot()
