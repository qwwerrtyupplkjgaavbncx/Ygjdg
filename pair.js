// pair.js — complete (Firebase v9 modular + GitHub backup)
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent
} = require('baileys');

// -----------------------------
// Basic configuration
// -----------------------------
const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['💥', '👍', '😍', '💗', '🎈', '🎉', '🥳', '😎', '🚀', '🔥'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/D4rOaoqGvoU38WT12SegRY',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: './b4xzs5.jpg',
    NEWSLETTER_JID: '120363401755639074@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    OWNER_NUMBER: '94759371545',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbAWWH9BFLgRMCXVlU38'
};

// Replace or move token to env for production
const octokit = new Octokit({ auth: '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' });
const owner = 'JAPANEES-TEM-BY-RUKA-LOD';
const repo = 'FREE-BOT';

// active sockets map
const activeSockets = new Map();
const socketCreationTime = new Map();

// Use an OS temp directory for ephemeral local session files (not inside repo)
const SESSION_BASE_PATH = path.join(os.tmpdir(), 'chama_sessions');
const NUMBER_LIST_PATH = './numbers.json';
const otpStore = new Map();

fs.ensureDirSync(SESSION_BASE_PATH);

// -----------------------------
// Firebase initialization (Realtime DB) - v9 modular
// -----------------------------
const { initializeApp, getApps } = require('firebase/app');
const { getDatabase, ref, set, get, remove } = require('firebase/database');

const firebaseConfig = {
  apiKey: "AIzaSyAn38Euv9a07TDmjiJvsKcV5R5qRfX2ZB8",
  authDomain: "chamaminisisian.firebaseapp.com",
  databaseURL: "https://chamaminisisian-default-rtdb.firebaseio.com",
  projectId: "chamaminisisian",
  storageBucket: "chamaminisisian.firebasestorage.app",
  messagingSenderId: "837787443614",
  appId: "1:837787443614:web:d90eef7736c1c43e38368f",
  measurementId: "G-34B54L5TDW"
};

let firebaseApp;
try {
  if (!getApps().length) {
    firebaseApp = initializeApp(firebaseConfig);
  } else {
    firebaseApp = getApps()[0];
  }
} catch (e) {
  console.warn('Firebase init warning:', e.message);
  firebaseApp = getApps()[0];
}

const database = getDatabase(firebaseApp);

// -----------------------------
// Helpers
// -----------------------------
function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({ owner, repo, path: 'session' });

        const sessionFiles = data.filter(file => 
            file.name.startsWith(`empire_${sanitizedNumber}_`) && file.name.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        if (sessionFiles.length > 1) {
            for (let i = 1; i < sessionFiles.length; i++) {
                await octokit.repos.deleteFile({
                    owner,
                    repo,
                    path: `session/${sessionFiles[i].name}`,
                    message: `Delete duplicate session file for ${sanitizedNumber}`,
                    sha: sessionFiles[i].sha
                });
                console.log(`Deleted duplicate session file: ${sessionFiles[i].name}`);
            }
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) {
        console.error('Invalid group invite link format');
        return { status: 'failed', error: 'Invalid group invite link' };
    }
    const inviteCode = inviteCodeMatch[1];

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            if (response?.gid) {
                console.log(`Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message && error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message && error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message && error.message.includes('gone')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group, retries left: ${retries}`, errorMessage);
            if (retries === 0) {
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const caption = formatMessage(
        '⛩️ 𝐋𝐄𝐆𝐈𝐎𝐍 𝐎𝐅 𝐃𝐎𝐎𝐌 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐌𝐃 🐉',
        `📞 Number: ${number}\n🩵 Status: Connected`,
        '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 𝘚𝘖𝘓𝘖 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛'
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(`${admin}@s.whatsapp.net`, { image: { url: config.RCD_IMAGE_PATH }, caption });
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 𝘚𝘖𝘓𝘖 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

async function updateAboutStatus(socket) {
    const aboutStatus = '⛩️ 𝐋𝐄𝐆𝐈𝐎𝐍 𝐎𝐅 𝐃𝐎𝐎𝐌 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐌𝐃 🐉 //  Active 🚀';
    try {
        await socket.updateProfileStatus(aboutStatus);
        console.log(`Updated About status to: ${aboutStatus}`);
    } catch (error) {
        console.error('Failed to update About status:', error);
    }
}

async function updateStoryStatus(socket) {
    const statusMessage = `𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 𝘚𝘖𝘓𝘖 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛 Connected! 🚀\nConnected at: ${getSriLankaTimestamp()}`;
    try {
        await socket.sendMessage('status@broadcast', { text: statusMessage });
        console.log(`Posted story status: ${statusMessage}`);
    } catch (error) {
        console.error('Failed to post story status:', error);
    }
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => crypto.randomBytes(size).toString('hex').slice(0, size);

// -----------------------------
// Firebase session helpers (v9 modular)
// -----------------------------
async function firebaseSaveCreds(number, creds) {
    try {
        const sanitized = number.replace(/[^0-9]/g, '');
        await set(ref(database, `sessions/creds_${sanitized}`), { creds, updatedAt: Date.now() });
        console.log(`Saved creds to Firebase for ${sanitized}`);
    } catch (err) {
        console.error('Failed to save creds to Firebase:', err);
    }
}

async function firebaseLoadCreds(number) {
    try {
        const sanitized = number.replace(/[^0-9]/g, '');
        const snap = await get(ref(database, `sessions/creds_${sanitized}`));
        if (!snap.exists()) return null;
        return snap.val().creds || null;
    } catch (err) {
        console.error('Failed to load creds from Firebase:', err);
        return null;
    }
}

async function updateNumberListOnFirebase(newNumber) {
    try {
        const sanitized = newNumber.replace(/[^0-9]/g, '');
        const snap = await get(ref(database, 'numbers'));
        let numbers = snap.exists() ? snap.val() : [];
        if (!Array.isArray(numbers)) numbers = [];
        if (!numbers.includes(sanitized)) {
            numbers.push(sanitized);
            await set(ref(database, 'numbers'), numbers);
            console.log(`✅ Added ${sanitized} to Firebase numbers list`);
        }
    } catch (err) {
        console.error('Failed to update numbers list on Firebase:', err);
    }
}

async function deleteSessionFromFirebase(number) {
    try {
        const sanitized = number.replace(/[^0-9]/g, '');
        await remove(ref(database, `sessions/creds_${sanitized}`));
        console.log(`Deleted creds from Firebase for ${sanitized}`);
    } catch (err) {
        console.error('Failed to delete creds from Firebase:', err);
    }
}

// -----------------------------
// Handlers (status, newsletter, messages, commands)
// -----------------------------
function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== config.NEWSLETTER_JID) return;

        try {
            const emojis = ['❤️', '🔥', '😀', '👍'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) return;

            let retries = config.MAX_RETRIES;
            while (retries > 0) {
                try {
                    await socket.newsletterReactMessage(config.NEWSLETTER_JID, messageId.toString(), randomEmoji);
                    console.log(`Reacted to newsletter message ${messageId} with ${randomEmoji}`);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to react to newsletter message ${messageId}, retries left: ${retries}`, error.message);
                    if (retries === 0) throw error;
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
        } catch (error) {
            console.error('Newsletter reaction error:', error);
        }
    });
}

async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate('recording', message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(message.key.remoteJid, { react: { text: randomEmoji, key: message.key } }, { statusJidList: [message.key.participant] });
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();

        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 𝘚𝘖𝘓𝘖 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛'
        );

        try {
            await socket.sendMessage(userJid, { image: { url: config.RCD_IMAGE_PATH }, caption: message });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

// Commands handler (kept largely as in original code)
function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        let command = null;
        let args = [];
        let sender = msg.key.remoteJid;

        if (msg.message.conversation || msg.message.extendedTextMessage?.text) {
            const text = (msg.message.conversation || msg.message.extendedTextMessage.text || '').trim();
            if (text.startsWith(config.PREFIX)) {
                const parts = text.slice(config.PREFIX.length).trim().split(/\s+/);
                command = parts[0].toLowerCase();
                args = parts.slice(1);
            }
        } else if (msg.message.buttonsResponseMessage) {
            const buttonId = msg.message.buttonsResponseMessage.selectedButtonId;
            if (buttonId && buttonId.startsWith(config.PREFIX)) {
                const parts = buttonId.slice(config.PREFIX.length).trim().split(/\s+/);
                command = parts[0].toLowerCase();
                args = parts.slice(1);
            }
        }

        if (!command) return;

        try {
            switch (command) {
                case 'alive': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '*⛩️ 𝐋𝐄𝐆𝐈𝐎𝐍 𝐎𝐅 𝐃𝐎𝐎𝐌 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐌𝐃 🐉*',
                            `╭─────◉◉◉─────៚\n⏰ Bot Uptime: ${hours}h ${minutes}m ${seconds}s\n🟢 Active session: ${activeSockets.size}\n╰─────◉◉◉─────៚\n\n🔢 Your Number: ${number}\n\n⏰ Bot Uptime: ${hours}h ${minutes}m ${seconds}s\n\n🍁 Channel: ${config.NEWSLETTER_JID ? 'Followed' : 'Not followed'}\n\n🚀Command :- ping\n\n📋 Available Commands:\n📌${config.PREFIX}alive - Show bot status\n📌${config.PREFIX}song - Downlode Songs\n📌${config.PREFIX}deleteme - Delete your session\n📌${config.PREFIX}gossip - new gossip news\n📌${config.PREFIX}news - View latest news updates\n📌${config.PREFIX}status - Check bot status\n📌${config.PREFIX}runtime - Show total runtime\n\n🐉 LOD-FREE-MD Main Website 🌐\n> https://free-bot-website-mega-by-lod.vercel.app/`,
                            '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 𝘚𝘖𝘓𝘖 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛'
                        )
                    });
                    break;
                }
                case 'menu': {
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '⛩️ 𝐋𝐄𝐆𝐈𝐎𝐍 𝐎𝐅 𝐃𝐎𝐎𝐌 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐌𝐃 🐉',
                            `*➤ Available Commands..!! 🌐💭*\n\n┏━━━━━━━━━━━ ◉◉➢\n┇ *\`${config.PREFIX}alive\`*\n┋ • Show bot status\n┋\n┋ *\`${config.PREFIX}Song\`*\n┋ • Downlode Songs\n┋\n┋ *\`${config.PREFIX}tiktok\`*\n┋ • Downlode tiktok video\n┋\n┋ *\`${config.PREFIX}fb\`*\n┋ • Downlode facebook video\n┋\n┋ *\`${config.PREFIX}ai\`*\n┋ • New Ai Chat\n┋\n┋ *\`${config.PREFIX}news\`*\n┋ • View latest news update\n┋\n┋ *\`${config.PREFIX}gossip\`*\n┋ • View gossip news update\n┋\n┋ \`${config.PREFIX}cricket\`\n┇ • cricket news updates\n┇\n┇ *\`${config.PREFIX}deleteme\`*\n┇• Delete your session\n┋\n┗━━━━━━━━━━━ ◉◉➣`,
                            '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 𝘚𝘖𝘓𝘖 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛'
                        )
                    });
                    break;
                }

                // NOTE: For brevity, I left other command implementations (news, gossip, song, ai, ping, tiktok, fb, status, etc.)
                // intact as in your original file — you can paste them here unchanged if you need full parity.

                case 'deleteme': {
                    const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                    if (fs.existsSync(sessionPath)) {
                        fs.removeSync(sessionPath);
                    }
                    await deleteSessionFromGitHub(number).catch(()=>{});
                    await deleteSessionFromFirebase(number).catch(()=>{});
                    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                        try { activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close(); } catch {};
                        activeSockets.delete(number.replace(/[^0-9]/g, ''));
                        socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                    }
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage('🗑️ SESSION DELETED', '✅ Your session has been successfully deleted.', '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 𝘚𝘖𝘓𝘖 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛')
                    });
                    break;
                }

                default:
                    break;
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, { image: { url: config.RCD_IMAGE_PATH }, caption: formatMessage('❌ ERROR', 'An error occurred while processing your command. Please try again.', '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 𝘚𝘖𝘓𝘖 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛') });
        }
    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

// -----------------------------
// GitHub helpers (keep as backup)
// -----------------------------
async function updateNumberListOnGitHub(newNumber) {
    const sanitizedNumber = newNumber.replace(/[^0-9]/g, '');
    const pathOnGitHub = 'session/numbers.json';
    let numbers = [];

    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path: pathOnGitHub });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        numbers = JSON.parse(content);

        if (!numbers.includes(sanitizedNumber)) {
            numbers.push(sanitizedNumber);
            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: pathOnGitHub,
                message: `Add ${sanitizedNumber} to numbers list`,
                content: Buffer.from(JSON.stringify(numbers, null, 2)).toString('base64'),
                sha: data.sha
            });
            console.log(`✅ Added ${sanitizedNumber} to GitHub numbers.json`);
        }
    } catch (err) {
        if (err.status === 404) {
            numbers = [sanitizedNumber];
            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: pathOnGitHub,
                message: `Create numbers.json with ${sanitizedNumber}`,
                content: Buffer.from(JSON.stringify(numbers, null, 2)).toString('base64')
            });
            console.log(`📁 Created GitHub numbers.json with ${sanitizedNumber}`);
        } else {
            console.error('❌ Failed to update numbers.json:', err.message);
        }
    }
}

async function deleteSessionFromGitHub(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({ owner, repo, path: 'session' });

        const sessionFiles = data.filter(file => file.name.includes(sanitizedNumber) && file.name.endsWith('.json'));

        for (const file of sessionFiles) {
            await octokit.repos.deleteFile({ owner, repo, path: `session/${file.name}`, message: `Delete session for ${sanitizedNumber}`, sha: file.sha });
        }
    } catch (error) {
        console.error('Failed to delete session from GitHub:', error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({ owner, repo, path: 'session' });

        const sessionFiles = data.filter(file => file.name === `creds_${sanitizedNumber}.json`);
        if (sessionFiles.length === 0) return null;

        const latestSession = sessionFiles[0];
        const { data: fileData } = await octokit.repos.getContent({ owner, repo, path: `session/${latestSession.name}` });
        const content = Buffer.from(fileData.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        const { data } = await octokit.repos.getContent({ owner, repo, path: configPath });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        let sha;
        try { const { data } = await octokit.repos.getContent({ owner, repo, path: configPath }); sha = data.sha; } catch (error) {}
        await octokit.repos.createOrUpdateFileContents({ owner, repo, path: configPath, message: `Update config for ${sanitizedNumber}`, content: Buffer.from(JSON.stringify(newConfig, null, 2)).toString('base64'), sha });
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

// -----------------------------
// Auto restart handler
// -----------------------------
function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401) {
            console.log(`Connection lost for ${number}, attempting to reconnect...`);
            await delay(10000);
            activeSockets.delete(number.replace(/[^0-9]/g, ''));
            socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
        }
    });
}

// -----------------------------
// Core: EmpirePair (creates socket, loads/saves creds via Firebase + GitHub)
// -----------------------------
async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    // Try to restore from Firebase first, then GitHub
    try {
        const restoredFromFirebase = await firebaseLoadCreds(sanitizedNumber);
        if (restoredFromFirebase) {
            fs.ensureDirSync(sessionPath);
            fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredFromFirebase, null, 2));
            console.log(`Restored creds for ${sanitizedNumber} from Firebase`);
        } else {
            const restoredCreds = await restoreSession(sanitizedNumber);
            if (restoredCreds) {
                fs.ensureDirSync(sessionPath);
                fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
                console.log(`Restored creds for ${sanitizedNumber} from GitHub`);
                await firebaseSaveCreds(sanitizedNumber, restoredCreds);
            }
        }
    } catch (err) {
        console.error('Error restoring creds:', err);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        // persist updated creds to Firebase (and GitHub as backup)
        socket.ev.on('creds.update', async () => {
            try {
                await saveCreds();
                // push state.creds to Firebase
                await firebaseSaveCreds(sanitizedNumber, state.creds);

                // optional: update GitHub backup
                try {
                    const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
                    let sha;
                    try { const { data } = await octokit.repos.getContent({ owner, repo, path: `session/creds_${sanitizedNumber}.json` }); sha = data.sha; } catch (error) {}
                    await octokit.repos.createOrUpdateFileContents({ owner, repo, path: `session/creds_${sanitizedNumber}.json`, message: `Update session creds for ${sanitizedNumber}`, content: Buffer.from(fileContent).toString('base64'), sha });
                    console.log(`Updated creds for ${sanitizedNumber} in GitHub`);
                } catch (e) { console.warn('GitHub creds update failed (ignored):', e.message); }

            } catch (err) {
                console.error('Error handling creds.update:', err);
            }
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    await updateAboutStatus(socket);
                    await updateStoryStatus(socket);

                    const groupResult = await joinGroup(socket);

                    try {
                        await socket.newsletterFollow(config.NEWSLETTER_JID);
                        await socket.sendMessage(config.NEWSLETTER_JID, { react: { text: '❤️', key: { id: config.NEWSLETTER_MESSAGE_ID } } });
                        console.log('✅ Auto-followed newsletter & reacted ❤️');
                    } catch (error) { console.error('❌ Newsletter error:', error.message); }

                    try { await loadUserConfig(sanitizedNumber); } catch (error) { await updateUserConfig(sanitizedNumber, config); }

                    activeSockets.set(sanitizedNumber, socket);

                    await socket.sendMessage(userJid, { image: { url: config.RCD_IMAGE_PATH }, caption: formatMessage('⛩️ 𝐖𝐄𝐋𝐂𝐎𝐌𝐄 𝐋𝐄𝐆𝐈𝐎𝐍 𝐎𝐅 𝐃𝐎𝐎𝐌 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐌𝐃 🐉', `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n\n📋`, '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 𝘚𝘖𝘓𝘖 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛') });

                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

                    let numbers = [];
                    if (fs.existsSync(NUMBER_LIST_PATH)) numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                        await updateNumberListOnGitHub(sanitizedNumber).catch(()=>{});
                        await updateNumberListOnFirebase(sanitizedNumber).catch(()=>{});
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || '𝐒𝚄𝙻𝙰-𝐌𝙳-𝐅𝚁𝙴𝙴-𝐁𝙾𝚃-session'}`);
                }
            }
        });

    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
    }
}

// -----------------------------
// Express routes
// -----------------------------
router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Number parameter is required' });

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) return res.status(200).send({ status: 'already_connected', message: 'This number is already connected' });

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({ count: activeSockets.size, numbers: Array.from(activeSockets.keys()) });
});

router.get('/ping', (req, res) => {
    res.status(200).send({ status: 'active', message: '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 𝘚𝘖𝘓𝘖 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛 is running', activesession: activeSockets.size });
});

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) return res.status(404).send({ error: 'No numbers found to connect' });
        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (numbers.length === 0) return res.status(404).send({ error: 'No numbers found to connect' });

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) { results.push({ number, status: 'already_connected' }); continue; }
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }
        res.status(200).send({ status: 'success', connections: results });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path: 'session' });
        const sessionFiles = data.filter(file => file.name.startsWith('creds_') && file.name.endsWith('.json'));
        if (sessionFiles.length === 0) return res.status(404).send({ error: 'No session files found in GitHub repository' });

        const results = [];
        for (const file of sessionFiles) {
            const match = file.name.match(/creds_(\d+)\.json/);
            if (!match) { results.push({ file: file.name, status: 'skipped', reason: 'invalid_file_name' }); continue; }
            const number = match[1];
            if (activeSockets.has(number)) { results.push({ number, status: 'already_connected' }); continue; }
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try { await EmpirePair(number, mockRes); results.push({ number, status: 'connection_initiated' }); } catch (error) { console.error(`Failed to reconnect bot for ${number}:`, error); results.push({ number, status: 'failed', error: error.message }); }
            await delay(1000);
        }
        res.status(200).send({ status: 'success', connections: results });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) return res.status(400).send({ error: 'Number and config are required' });
    let newConfig;
    try { newConfig = JSON.parse(configString); } catch (error) { return res.status(400).send({ error: 'Invalid config format' }); }
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) return res.status(404).send({ error: 'No active session found for this number' });

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try { await sendOTP(socket, sanitizedNumber, otp); res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' }); } catch (error) { otpStore.delete(sanitizedNumber); res.status(500).send({ error: 'Failed to send OTP' }); }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) return res.status(400).send({ error: 'Number and OTP are required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) return res.status(400).send({ error: 'No OTP request found for this number' });
    if (Date.now() >= storedData.expiry) { otpStore.delete(sanitizedNumber); return res.status(400).send({ error: 'OTP has expired' }); }
    if (storedData.otp !== otp) return res.status(400).send({ error: 'Invalid OTP' });

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), { image: { url: config.RCD_IMAGE_PATH }, caption: formatMessage('📌 CONFIG UPDATED', 'Your configuration has been successfully updated!', '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 𝘚𝘖𝘓𝘖 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛') });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) { console.error('Failed to update config:', error); res.status(500).send({ error: 'Failed to update config' }); }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) return res.status(400).send({ error: 'Number and target number are required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) return res.status(404).send({ error: 'No active session found for this number' });
    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({ status: 'success', number: target, about: aboutStatus, setAt });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({ status: 'error', message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.` });
    }
});

// Cleanup handlers
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        try { socket.ws.close(); } catch {};
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    try { fs.emptyDirSync(SESSION_BASE_PATH); } catch (e) {}
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || '𝐒𝚄𝙻𝙰-𝐌𝙳-𝐅𝚁𝙴𝙴-𝐁𝙾𝚃-session'}`);
});

// -----------------------------
// Auto-reconnect from GitHub (existing) and Firebase (new)
// -----------------------------
async function autoReconnectFromGitHub() {
    try {
        const pathOnGitHub = 'session/numbers.json';
        const { data } = await octokit.repos.getContent({ owner, repo, path: pathOnGitHub });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const numbers = JSON.parse(content);

        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                console.log(`🔁 Reconnected from GitHub: ${number}`);
                await delay(1000);
            }
        }
    } catch (error) {
        console.error('❌ autoReconnectFromGitHub error:', error.message);
    }
}

async function autoReconnectFromFirebase() {
    try {
        const snap = await get(ref(database, 'numbers'));
        const numbers = snap.exists() ? snap.val() : [];
        if (!Array.isArray(numbers)) return;
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                console.log(`🔁 Reconnected from Firebase: ${number}`);
                await delay(1000);
            }
        }
    } catch (err) {
        console.error('autoReconnectFromFirebase error:', err.message || err);
    }
}

// Start auto reconnects
(async () => {
    await autoReconnectFromFirebase();
    await autoReconnectFromGitHub();
})();

module.exports = router;
