// ============================================================
// config.js - users.json aur watched.json banane/badalne ka simple menu
//
// Chalao:  node config.js
//
// Kya karta hai:
//  - Sawal poochta hai, tum jawab likhte ho, script khud sahi JSON file likhti hai
//    (koi { } " , manually likhna nahi padta, isliye galti se file kharab nahi hogi)
//  - File pehle se ho to uska data padh kar dikhata hai, badalne/delete karne deta hai
//  - Har change ke turant baad file save ho jaati hai
//  - Sirf Node ke built-in modules use hote hain, kuch install nahi karna
// ============================================================

const fs = require('fs')
const path = require('path')
const readline = require('readline/promises')

const AUTH_DIR = path.join(__dirname, 'auth_info')

const USERS_FILE = path.join(__dirname, 'users.json')
const WATCHED_FILE = path.join(__dirname, 'watched.json')
const MAX_USERS = 5
// Regex fix hai (user se nahi poochte). Purani watched.json mein jo regex ho wahi rehta hai.
const DEFAULT_TRIGGER = '\\b[0-9]{7,9}\\b'
const DEFAULT_EXTRACT = '[0-9]+'
const DEFAULT_NOTE = "JID formats: group = xxxx@g.us | channel = xxxx@newsletter | person = 91XXXXXXXXXX@s.whatsapp.net. live_update_minutes: 0 ho to live update nahi jayega."

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })


// ------------------------------------------------------------
// Sawal poochne ke chhote helpers
// ------------------------------------------------------------
async function ask(question) {
    return (await rl.question(question)).trim()
}

// Enter dabane par purani value (def) hi rahegi. shown = screen par kya dikhana hai
// (password ke liye "****" dikhate hain)
async function askDefault(question, def, shown) {
    const view = shown !== undefined ? shown : def
    const answer = await ask(view ? `${question} [abhi: ${view}] : ` : `${question} : `)
    return answer === '' ? def : answer
}

async function askYesNo(question) {
    while (true) {
        const a = (await ask(`${question} (y/n): `)).toLowerCase()
        if (['y', 'yes', 'h', 'ha', 'haan'].includes(a)) return true
        if (['n', 'no', 'na', 'nahi'].includes(a)) return false
        console.log('   ⚠️ y ya n likho')
    }
}


// ------------------------------------------------------------
// File padhna / likhna
// - File kharab (galat JSON) ho to uski copy .bak mein rakh ke nayi bana dete hain
// - Likhte waqt pehle .tmp mein likhte hain phir rename, taaki beech mein
//   band hone par file adhoori na rahe
// ------------------------------------------------------------
function readJson(file, fallback) {
    if (!fs.existsSync(file)) return fallback
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        const bak = file + '.bak'
        fs.copyFileSync(file, bak)
        console.log(`⚠️ ${path.basename(file)} kharab thi - purani copy ${path.basename(bak)} mein rakh di, nayi bana raha hoon`)
        return fallback
    }
}

function writeJson(file, data) {
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
}


// ------------------------------------------------------------
// Number / JID ko sahi format mein badalne ke helpers
// ------------------------------------------------------------

// "9876543210", "+91 98765 43210", "919876543210" -> "9876543210" (galat ho to null)
function parsePhone(input) {
    let d = String(input || '').replace(/[\s+\-]/g, '')
    if (/^91\d{10}$/.test(d)) d = d.slice(2)
    return /^\d{10}$/.test(d) ? d : null
}

// Person: 10 digit number ya poora JID -> "91XXXXXXXXXX@s.whatsapp.net"
function normalizePerson(input) {
    const m = String(input).match(/(\d{10,15})@s\.whatsapp\.net/)
    if (m) return m[0]
    const phone = parsePhone(input)
    return phone ? `91${phone}@s.whatsapp.net` : null
}

// Group / Channel: poori line paste kar do ("Naam -> 1203...@g.us") to bhi JID nikal leta hai
function normalizeGroup(input) {
    const m = String(input).match(/[0-9]+(?:-[0-9]+)?@g\.us/)
    return m ? m[0] : null
}

function normalizeChannel(input) {
    const m = String(input).match(/[0-9]+@newsletter/)
    return m ? m[0] : null
}

// Channel invite link/text se invite code nikalta hai (aage-peeche faltu
// text ho tab bhi). "https://whatsapp.com/channel/XXXXXXXX" -> "XXXXXXXX"
function extractInviteCode(input) {
    const text = String(input || '')
    const m = text.match(/channel\/([A-Za-z0-9_-]{6,})/)
    if (m) return m[1]
    const fallback = text.trim().match(/[A-Za-z0-9_-]{8,}/)
    return fallback ? fallback[0] : null
}


// ------------------------------------------------------------
// WhatsApp se live connect (groups list dekhne / channel link resolve
// karne ke liye). Poore session mein ek hi connection reuse hota hai.
// ------------------------------------------------------------
let waSocket = null

async function connectWA() {
    if (waSocket) return waSocket

    if (!fs.existsSync(AUTH_DIR)) {
        throw new Error("pehle 'node bot.js' chalake QR scan karo, tabhi yeh kaam karega")
    }

    console.log('   🔌 WhatsApp se connect ho raha hoon... (agar bot.js chal raha hai to use pehle Ctrl+C se band kar do, warna connection conflict ho sakta hai)')

    const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys')
    const pino = require('pino')

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false })
    sock.ev.on('creds.update', saveCreds)

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('30 second mein connect nahi hua - internet check karo')), 30000)
        sock.ev.on('connection.update', (u) => {
            if (u.connection === 'open') { clearTimeout(timer); resolve() }
            if (u.connection === 'close') { clearTimeout(timer); reject(new Error('connection band ho gayi')) }
        })
    })

    console.log('   ✅ Connected')
    waSocket = sock
    return waSocket
}

function closeWA() {
    if (waSocket) {
        try { waSocket.end() } catch { /* ignore */ }
    }
}

// Live groups fetch karke number se chunwaata hai -> { jid, label } ya null
async function pickGroupFromList() {
    let sock
    try {
        sock = await connectWA()
    } catch (err) {
        console.log(`   ⚠️ WhatsApp connect nahi ho paya: ${err.message}`)
        return null
    }

    console.log('   ⏳ Groups fetch kar raha hoon...')
    let groups
    try {
        groups = Object.values(await sock.groupFetchAllParticipating())
    } catch (err) {
        console.log(`   ⚠️ Groups fetch nahi ho paye: ${err.message}`)
        return null
    }

    if (!groups.length) { console.log('   ⚠️ Koi group nahi mila'); return null }

    groups.forEach((g, i) => console.log(`   ${i + 1}. ${g.subject}`))
    const c = await ask('Number chuno (Enter = cancel) : ')
    if (!c) return null
    const n = Number(c)
    if (!Number.isInteger(n) || n < 1 || n > groups.length) { console.log('   ⚠️ list ka sahi number likho'); return null }

    return { jid: groups[n - 1].id, label: groups[n - 1].subject }
}

// Channel invite link maang kar resolve karta hai -> { jid, label } ya null
async function pickChannelFromLink() {
    const v = await ask('Channel ka invite link paste karo (Enter = cancel) : ')
    if (!v) return null

    const code = extractInviteCode(v)
    if (!code) { console.log('   ⚠️ isme se invite code nahi mila'); return null }

    let sock
    try {
        sock = await connectWA()
    } catch (err) {
        console.log(`   ⚠️ WhatsApp connect nahi ho paya: ${err.message}`)
        return null
    }

    console.log('   ⏳ Channel dhoondh raha hoon...')
    try {
        const meta = await sock.newsletterMetadata('invite', code)
        if (!meta || !meta.id) { console.log('   ⚠️ Channel nahi mila - link check karo'); return null }
        // Baileys yahan raw server response deta hai - naam flat "name" mein
        // nahi, "thread_metadata.name.text" mein hota hai
        const name = meta.thread_metadata?.name?.text || meta.name || meta.id
        return { jid: meta.id, label: name }
    } catch (err) {
        console.log(`   ⚠️ Error: ${err.message}`)
        return null
    }
}


// Destination chunwaane ke 4 tarike - group list, channel link, person number,
// ya seedha JID paste. Forward wala "kahan bhejna hai" isi se poochha jaata hai.
async function pickDestination() {
    console.log('   Kahan forward karna hai?')
    console.log('   1. Group (list se chuno)')
    console.log('   2. Channel (invite link paste karo)')
    console.log('   3. Person (10 digit number)')
    console.log('   4. JID seedha paste karo')
    const c = await ask('   Chuno (Enter = cancel) : ')
    if (c === '1') return await pickGroupFromList()
    if (c === '2') return await pickChannelFromLink()
    if (c === '3') {
        const v = await ask('   Number likho : ')
        if (!v) return null
        const jid = normalizePerson(v)
        if (!jid) { console.log('   ⚠️ 10 digit ka number likho (jaise 9876543210)'); return null }
        return { jid, label: jid }
    }
    if (c === '4') {
        const v = await ask('   JID paste karo : ')
        if (!v) return null
        const jid = normalizeGroup(v) || normalizeChannel(v) || normalizePerson(v)
        if (!jid) { console.log('   ⚠️ ye JID samajh nahi aaya'); return null }
        return { jid, label: jid }
    }
    if (c) console.log('   ⚠️ 1 se 4 mein se chuno')
    return null
}

// ============================================================
// USERS (users.json)
// ============================================================
let users = []        // hamesha MAX_USERS (5) slots
let extraUsers = []   // agar file mein 5 se zyada the - unhe chhedte nahi, waise hi wapas likh dete hain

const emptyUser = (n) => ({ user: `user${n}`, username: '', password: '', session: '', notify: '', update: '', verify_id: '' })
const isFilled = (u) => Boolean(u.username && u.password)

function loadUsers() {
    const raw = readJson(USERS_FILE, [])
    const arr = Array.isArray(raw) ? raw : []
    users = []
    for (let i = 0; i < MAX_USERS; i++) users.push({ ...emptyUser(i + 1), ...(arr[i] || {}) })
    extraUsers = arr.slice(MAX_USERS)
}

function saveUsers() {
    writeJson(USERS_FILE, [...users, ...extraUsers])
    console.log('   💾 users.json save ho gayi')
}

// Kisi bhi extra JID (group/channel/person) par bhi price-update bhejna ho
// to yahan set hota hai - 'p' dabane par list/link se pick kar sakte ho
async function askUpdateJid(cur) {
    console.log(`\nKisi aur JID (group/number) par bhi price milne par update bhejni hai? Abhi: ${cur || '(set nahi)'}`)
    console.log("   Enter = jaisa hai waisa rahega, '-' = hata do, 'p' = list/link se pick karo, ya seedha JID paste karo")
    while (true) {
        const v = await ask('   Chuno : ')
        if (v === '') return cur
        if (v === '-') return ''
        if (v.toLowerCase() === 'p') {
            const dest = await pickDestination()
            if (dest) return dest.jid
            continue
        }
        const jid = normalizeGroup(v) || normalizeChannel(v) || normalizePerson(v)
        if (!jid) { console.log('   ⚠️ format samajh nahi aaya'); continue }
        return jid
    }
}

async function editUser(idx) {
    const cur = users[idx]
    console.log(`\n--- Slot ${idx + 1} --- (Enter dabane par purani value rahegi)`)

    const name = await askDefault('Naam (sirf pehchaan ke liye)', cur.user)

    let phone
    while (true) {
        const a = await askDefault('Login number (10 digit)', cur.username)
        phone = parsePhone(a)
        if (!phone) { console.log('   ⚠️ 10 digit ka number likho (jaise 9876543210)'); continue }
        const dup = users.findIndex((x, i) => i !== idx && x.username === phone)
        if (dup >= 0) { console.log(`   ⚠️ ye number slot ${dup + 1} mein pehle se hai`); continue }
        break
    }

    let pass
    while (true) {
        pass = await askDefault('Password', cur.password, cur.password ? '****' : '')
        if (pass) break
        console.log('   ⚠️ Password khaali nahi ho sakta')
    }

    const notify = (await askYesNo('Redeem hone par apne number par WhatsApp message chahiye?')) ? 'yes' : ''
    const update = await askUpdateJid(cur.update || '')

    // Number ya password badla to purana session hata do (script dobara login karke naya bharegi)
    const same = phone === cur.username && pass === cur.password
    users[idx] = {
        user: name || `user${idx + 1}`,
        username: phone,
        password: pass,
        session: same ? cur.session : '',
        notify,
        update,
        verify_id: phone === cur.username ? cur.verify_id : ''
    }
    saveUsers()
}

async function usersMenu() {
    while (true) {
        console.log('\n===== USERS =====')
        users.forEach((u, i) => {
            console.log(`${i + 1}. ` + (isFilled(u)
                ? `${u.user} | ${u.username} | message: ${u.notify === 'yes' ? 'haan' : 'nahi'} | update: ${u.update || 'nahi'} | session: ${u.session ? 'hai' : 'nahi'}`
                : '(khaali)'))
        })
        if (extraUsers.length) console.log(`(⚠️ file mein ${extraUsers.length} extra user aur hain - bot sirf pehle ${MAX_USERS} use karta hai)`)

        const c = await ask('\nSlot number chuno (1-5) ya 0 = wapas: ')
        if (c === '0') return

        const n = Number(c)
        if (!Number.isInteger(n) || n < 1 || n > MAX_USERS) {
            console.log('   ⚠️ 1 se 5 ke beech ka number likho, ya 0')
            continue
        }

        const u = users[n - 1]
        if (!isFilled(u)) {
            await editUser(n - 1)
            continue
        }

        const a = (await ask(`Slot ${n} (${u.user}): e = badlo, d = delete, Enter = wapas : `)).toLowerCase()
        if (a === 'e') {
            await editUser(n - 1)
        } else if (a === 'd') {
            if (await askYesNo(`Slot ${n} (${u.user}) delete karu?`)) {
                users[n - 1] = emptyUser(n)
                saveUsers()
            }
        }
    }
}


// ============================================================
// WATCHED (watched.json)
// ============================================================
let watched = {}

function defaultWatched() {
    return {
        _note: DEFAULT_NOTE,
        notification_jid: '',
        live_update_minutes: 0,
        groups: [],
        channels: [],
        persons: [],
        channel_names: {},
        forwards: [],
        trigger_regex: DEFAULT_TRIGGER,
        extract_regex: DEFAULT_EXTRACT
    }
}

function loadWatched() {
    const raw = readJson(WATCHED_FILE, {})
    const w = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : [])

    // "91XXXXXXXXXX@..." jaisa placeholder ho to use "set nahi" maano
    const notif = typeof w.notification_jid === 'string' && !/X{4}/.test(w.notification_jid) ? w.notification_jid : ''

    watched = {
        ...w,
        _note: w._note || DEFAULT_NOTE,
        notification_jid: notif,
        live_update_minutes: Number(w.live_update_minutes) || 0,
        groups: list(w.groups),
        channels: list(w.channels),
        persons: list(w.persons),
        channel_names: (w.channel_names && typeof w.channel_names === 'object' && !Array.isArray(w.channel_names)) ? w.channel_names : {},
        forwards: Array.isArray(w.forwards) ? w.forwards.filter(f => f && f.from && f.to) : [],
        trigger_regex: w.trigger_regex || DEFAULT_TRIGGER,
        extract_regex: w.extract_regex || DEFAULT_EXTRACT
    }
}

function saveWatched() {
    writeJson(WATCHED_FILE, watched)
    console.log('   💾 watched.json save ho gayi')
}

// Channel add hote waqt uska asli naam yaad rakh lete hain (agar mila),
// taaki forward ke waqt bot.js ko koi API call na karni pade
function rememberChannelName(jid, label) {
    if (jid && label && label !== jid) {
        watched.channel_names[jid] = label
    }
}

// Naya JID add karne ka tarika, key ke hisaab se alag:
//  - groups   : list se chuno YA khud JID paste karo
//  - channels : hamesha invite link paste karo (koi manual JID nahi -
//               channel ka JID yaad rakhna mushkil hai, link hi asaan hai)
//  - persons  : seedha 10 digit number
async function addToList(key) {
    if (key === 'groups') {
        console.log('   1. List se chuno   2. JID khud paste karo')
        const c = await ask('   Chuno (Enter = cancel) : ')
        if (c === '1') return await pickGroupFromList()
        if (c === '2') {
            const v = await ask('   Group ka JID paste karo (jaise 1203...@g.us, poori line bhi chalegi) : ')
            if (!v) return null
            const jid = normalizeGroup(v)
            if (!jid) { console.log('   ⚠️ format sahi nahi hai'); return null }
            return { jid, label: jid }
        }
        if (c) console.log('   ⚠️ 1 ya 2 likho')
        return null
    }

    if (key === 'channels') {
        return await pickChannelFromLink()
    }

    // persons
    const v = await ask('   Us insaan ka 10 digit number likho (jaise 9876543210) : ')
    if (!v) return null
    const jid = normalizePerson(v)
    if (!jid) { console.log('   ⚠️ 10 digit ka number likho'); return null }
    return { jid, label: jid }
}

// Groups / Channels / Persons ki list: dekho, add karo, delete karo
async function manageList(title, key) {
    while (true) {
        console.log(`\n===== ${title} =====`)
        if (!watched[key].length) console.log('(khaali)')
        watched[key].forEach((j, i) => console.log(`${i + 1}. ${j}`))

        const a = (await ask('\na = naya add, d = delete, 0 = wapas : ')).toLowerCase()
        if (a === '0') return

        if (a === 'a') {
            const picked = await addToList(key)
            if (!picked) continue
            if (watched[key].includes(picked.jid)) { console.log('   ⚠️ ye pehle se list mein hai'); continue }
            watched[key].push(picked.jid)
            if (key === 'channels') rememberChannelName(picked.jid, picked.label)
            saveWatched()
            console.log(`   ✅ Add ho gaya: ${picked.label}`)
        } else if (a === 'd') {
            if (!watched[key].length) { console.log('   ⚠️ delete karne ko kuch nahi hai'); continue }
            const n = Number(await ask('Kaunsa number delete karna hai? : '))
            if (!Number.isInteger(n) || n < 1 || n > watched[key].length) { console.log('   ⚠️ list ka sahi number likho'); continue }
            const removedJid = watched[key][n - 1]
            if (await askYesNo(`${removedJid} delete karu?`)) {
                watched[key].splice(n - 1, 1)
                // Is JID se jitne forward mapping bante the wo bhi hata do, warna
                // bot.js ko aisa source milega jo watch list mein hai hi nahi
                const before = watched.forwards.length
                watched.forwards = watched.forwards.filter(f => f.from !== removedJid)
                if (watched.forwards.length !== before) console.log('   (isse juda forward mapping bhi hata diya)')
                saveWatched()
            }
        } else {
            console.log('   ⚠️ a, d ya 0 likho')
        }
    }
}


// ------------------------------------------------------------
// Forward settings: kis watched JID se message aaye to poora
// message kahan forward karna hai (ek source ke kai destination
// ho sakte hain)
// ------------------------------------------------------------
function allWatchedSources() {
    return [
        ...watched.groups.map(j => ({ jid: j, label: `[Group] ${j}` })),
        ...watched.channels.map(j => ({ jid: j, label: `[Channel] ${j}` })),
        ...watched.persons.map(j => ({ jid: j, label: `[Person] ${j}` }))
    ]
}

// Source chunwaata hai: pehle se watched JID ki list dikhata hai, aur uske
// baad naya group/channel/person add karne ke bhi options deta hai. Naya
// pick hone par use watch list (groups/channels/persons) mein bhi daal
// deta hai - warna bot.js usse aane wala message dekhega hi nahi.
async function pickSource() {
    const existing = allWatchedSources()

    console.log('   Kis JID se message aaye tab forward karna hai?')
    existing.forEach((s, i) => console.log(`   ${i + 1}. ${s.label}`))

    const newGroupNum = existing.length + 1
    const newChannelNum = existing.length + 2
    const newPersonNum = existing.length + 3
    console.log(`   ${newGroupNum}. Naya Group (list se chuno)`)
    console.log(`   ${newChannelNum}. Naya Channel (invite link paste karo)`)
    console.log(`   ${newPersonNum}. Naya Person (number likho)`)

    const c = await ask('   Number chuno (Enter = cancel) : ')
    if (!c) return null
    const n = Number(c)
    if (!Number.isInteger(n) || n < 1 || n > newPersonNum) { console.log('   ⚠️ sahi number likho'); return null }

    if (n <= existing.length) return existing[n - 1]

    let picked = null
    let key = null
    if (n === newGroupNum) { picked = await pickGroupFromList(); key = 'groups' }
    else if (n === newChannelNum) { picked = await pickChannelFromLink(); key = 'channels' }
    else {
        const v = await ask('   Number likho (jaise 9876543210) : ')
        if (v) {
            const jid = normalizePerson(v)
            if (jid) picked = { jid, label: jid }
            else console.log('   ⚠️ 10 digit ka number likho')
        }
        key = 'persons'
    }
    if (!picked) return null

    if (!watched[key].includes(picked.jid)) {
        watched[key].push(picked.jid)
        if (key === 'channels') rememberChannelName(picked.jid, picked.label)
        saveWatched()
        console.log(`   (naya ${key === 'groups' ? 'group' : key === 'channels' ? 'channel' : 'person'} watch list mein bhi add ho gaya)`)
    }

    const typeLabel = key === 'groups' ? 'Group' : key === 'channels' ? 'Channel' : 'Person'
    return { jid: picked.jid, label: `[${typeLabel}] ${picked.jid}` }
}

async function forwardMenu() {
    while (true) {
        console.log('\n===== FORWARD SETTINGS =====')
        console.log('(Source se message aaye aur regex match ho to poora message forward hota hai - redeem ke saath parallel)')
        if (!watched.forwards.length) console.log('(khaali)')
        watched.forwards.forEach((f, i) => console.log(`${i + 1}. ${f.fromLabel || f.from}   ->   ${f.toLabel || f.to}`))

        const a = (await ask('\na = naya add, d = delete, 0 = wapas : ')).toLowerCase()
        if (a === '0') return

        if (a === 'a') {
            const source = await pickSource()
            if (!source) continue
            const { jid: from, label: fromLabel } = source

            const dest = await pickDestination()
            if (!dest) continue

            if (watched.forwards.some(f => f.from === from && f.to === dest.jid)) {
                console.log('   ⚠️ ye mapping pehle se hai')
                continue
            }

            watched.forwards.push({ from, to: dest.jid, fromLabel, toLabel: dest.label })
            saveWatched()
            console.log(`   ✅ ${fromLabel}  ->  ${dest.label}`)
        } else if (a === 'd') {
            if (!watched.forwards.length) { console.log('   ⚠️ delete karne ko kuch nahi hai'); continue }
            const n = Number(await ask('Kaunsa number delete karna hai? : '))
            if (!Number.isInteger(n) || n < 1 || n > watched.forwards.length) { console.log('   ⚠️ list ka sahi number likho'); continue }
            const f = watched.forwards[n - 1]
            if (await askYesNo(`${f.fromLabel || f.from}  ->  ${f.toLabel || f.to} delete karu?`)) {
                watched.forwards.splice(n - 1, 1)
                saveWatched()
            }
        } else {
            console.log('   ⚠️ a, d ya 0 likho')
        }
    }
}

async function setNotification() {
    console.log("\nYe wo number hai jis par 'i'm live' wala message jayega.")
    console.log("(Enter = purana rehne do, '-' = hata do)")
    while (true) {
        const a = await ask(`Notification number (10 digit)${watched.notification_jid ? ` [abhi: ${watched.notification_jid}]` : ''} : `)
        if (a === '') return
        if (a === '-') { watched.notification_jid = ''; saveWatched(); return }
        const jid = normalizePerson(a)
        if (!jid) { console.log('   ⚠️ 10 digit ka number likho (jaise 9876543210)'); continue }
        watched.notification_jid = jid
        saveWatched()
        return
    }
}

async function setLiveMinutes() {
    console.log("\nHar kitne minute par 'i'm live' message bhejna hai? (jaise 30 ya 60, 0 = band)")
    while (true) {
        const a = await ask(`Minutes [abhi: ${watched.live_update_minutes}] : `)
        if (a === '') return
        if (!/^\d+$/.test(a) || Number(a) > 1440) { console.log('   ⚠️ 0 se 1440 ke beech ka poora number likho'); continue }
        watched.live_update_minutes = Number(a)
        saveWatched()
        if (watched.live_update_minutes > 0 && !watched.notification_jid) {
            console.log('   ⚠️ Notification number abhi set nahi hai - pehle wo set karo, warna message nahi jayega')
        }
        return
    }
}

async function watchMenu() {
    while (true) {
        const live = watched.live_update_minutes > 0 ? `har ${watched.live_update_minutes} minute` : 'band'
        console.log('\n===== WATCH SETTINGS =====')
        console.log(`1. Notification number : ${watched.notification_jid || '(set nahi)'}`)
        console.log(`2. Live update         : ${live}`)
        console.log(`3. Groups              : ${watched.groups.length} JID`)
        console.log(`4. Channels            : ${watched.channels.length} JID`)
        console.log(`5. Persons             : ${watched.persons.length} JID`)
        console.log(`6. Forward settings    : ${watched.forwards.length} mapping`)

        const c = await ask('\nKya badalna hai? (1-6) ya 0 = wapas : ')
        if (c === '0') return
        if (c === '1') await setNotification()
        else if (c === '2') await setLiveMinutes()
        else if (c === '3') await manageList('GROUPS', 'groups')
        else if (c === '4') await manageList('CHANNELS', 'channels')
        else if (c === '5') await manageList('PERSONS', 'persons')
        else if (c === '6') await forwardMenu()
        else console.log('   ⚠️ 1 se 6 ke beech ka number likho, ya 0')
    }
}


// ============================================================
// Summary + Sab kuch delete
// ============================================================
function showSummary() {
    console.log('\n================ SUMMARY ================')
    console.log('USERS:')
    const filled = users.filter(isFilled)
    if (!filled.length) console.log('  (koi user nahi)')
    users.forEach((u, i) => {
        if (isFilled(u)) console.log(`  ${i + 1}. ${u.user} | ${u.username} | password: **** | message: ${u.notify === 'yes' ? 'haan' : 'nahi'} | update: ${u.update || 'nahi'} | session: ${u.session ? 'hai' : 'nahi'}`)
    })

    console.log('\nWATCH:')
    console.log(`  Notification number : ${watched.notification_jid || '(set nahi)'}`)
    console.log(`  Live update         : ${watched.live_update_minutes > 0 ? `har ${watched.live_update_minutes} minute` : 'band'}`)
    const show = (label, arr) => {
        console.log(`  ${label}: ${arr.length ? '' : '(khaali)'}`)
        arr.forEach(j => console.log(`     - ${j}`))
    }
    show('Groups  ', watched.groups)
    show('Channels', watched.channels)
    show('Persons ', watched.persons)

    console.log(`  Forwards: ${watched.forwards.length ? '' : '(khaali)'}`)
    watched.forwards.forEach(f => console.log(`     - ${f.fromLabel || f.from}  ->  ${f.toLabel || f.to}`))

    const problems = []
    if (!filled.length) problems.push('Koi user set nahi hai')
    if (!watched.groups.length && !watched.channels.length && !watched.persons.length) problems.push('Kisi bhi JID par nazar nahi rakhi gayi (groups/channels/persons sab khaali)')
    if (problems.length) {
        console.log('\n⚠️ Dhyan do:')
        problems.forEach(p => console.log(`   - ${p}`))
    } else {
        console.log('\n✅ Sab theek lag raha hai')
    }
}

async function resetAll() {
    console.log('\n⚠️ Isse saare users aur watch settings hamesha ke liye delete ho jayenge.')
    if (!(await askYesNo('Pakka sab kuch delete karke naye sire se shuru karna hai?'))) return
    users = [1, 2, 3, 4, 5].map(emptyUser)
    extraUsers = []
    watched = defaultWatched()
    saveUsers()
    saveWatched()
    console.log('   🧹 Sab kuch saaf ho gaya')
}


// ============================================================
// Main menu
// ============================================================
async function main() {
    loadUsers()
    loadWatched()

    // Files na hon to abhi hi bana do (pehle se hon to chhedte nahi)
    if (!fs.existsSync(USERS_FILE)) saveUsers()
    if (!fs.existsSync(WATCHED_FILE)) saveWatched()

    console.log('==============================================')
    console.log('  Bot Config - users aur watch settings')
    console.log('  Har change turant save hota hai.')
    console.log('==============================================')

    while (true) {
        console.log('\n===== MAIN MENU =====')
        console.log('1. Users (login wale accounts)')
        console.log('2. Watch settings (kis group/channel/person par nazar + notification)')
        console.log('3. Sab kuch ek nazar mein dekho')
        console.log('4. Sab kuch delete karke naye sire se shuru')
        console.log('0. Band karo')

        const c = await ask('\nNumber chuno : ')
        if (c === '0') break
        if (c === '1') await usersMenu()
        else if (c === '2') await watchMenu()
        else if (c === '3') showSummary()
        else if (c === '4') await resetAll()
        else console.log('   ⚠️ 0 se 4 ke beech ka number likho')
    }

    console.log('\n👋 Ho gaya. Ab bot chalao:  node bot.js')
    closeWA()
    rl.close()
    process.exit(0)
}

main().catch((err) => {
    // Input band ho jaye (Ctrl+C / Ctrl+D) to chup-chaap nikal jao
    if (err && /closed|abort/i.test(String(err.message || err.code))) {
        console.log('\n👋 Band kar diya. Jo save ho chuka hai wo file mein hai.')
    } else {
        console.log('❌ Error:', err.message)
    }
    closeWA()
    process.exit(0)
})
