/* eslint-disable no-case-declarations */
import http from 'node:http'
import path, { join } from 'node:path'
import crypto from 'node:crypto'
import fs from 'node:fs'
import EventEmitter from 'node:events'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { connection } from './js/proxy/proxyhandler.js'
import { checkProxy } from './js/proxy/proxycheck.js'
import { scrapeProxy } from './js/proxy/proxyscrape.js'
import {
  salt,
  delay,
  genName,
  botMode,
  sendEvent,
  proxyEvent,
  notify,
  cleanText,
  extractLore,
  friendlyWindowTitle,
  flattenTextComponent,
  setRendererSender
} from './js/misc/utils.js'
import { easyMcAuth } from './js/misc/customAuth.js'
import { antiafk } from './js/misc/antiafk.js'
import { DeliveryQueueManager } from './deliveryQueue.js'

const require = createRequire(import.meta.url)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Load .env if present
try {
  const envPath = path.resolve(process.cwd(), '.env')
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/)
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = (m[2] || '').replace(/^['"]|['"]$/g, '')
      }
    }
  }
} catch {}

// Allow resolving packages from root ../node_modules if wisp-bot/node_modules is not yet installed
const resolvePkg = (pkgName) => {
  try {
    return require(pkgName)
  } catch {
    const rootRequire = createRequire(path.resolve(__dirname, '../package.json'))
    return rootRequire(pkgName)
  }
}

const mineflayer = resolvePkg('mineflayer')
const { Authflow } = resolvePkg('prismarine-auth')
const {
  pathfinder,
  Movements,
  goals: { GoalBlock, GoalNear, GoalFollow }
} = resolvePkg('mineflayer-pathfinder')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

// =============================================================================
// 1. PERSISTENT STORE (Compatible with electron-store dot-path get/set/delete)
// =============================================================================
class JsonDotStore {
  constructor(filePath) {
    this.filePath = filePath
    this.data = {
      config: {
        value: {
          server: `${process.env.MC_SERVER_HOST || 'donutsmp.net'}:${process.env.MC_SERVER_PORT || 25565}`,
          version: process.env.MC_VERSION || '1.20.4',
          authType: process.env.MC_AUTH_TYPE || 'microsoft',
          username: process.env.MC_BOT_USERNAME || '',
          botMax: 1,
          joinDelay: 1000,
          proxyType: 'none'
        },
        boolean: {
          autoReconnect: true
        }
      },
      accountPresets: []
    }
    try {
      if (fs.existsSync(filePath)) {
        const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        this.data = { ...this.data, ...loaded }
      }
    } catch {}
  }

  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8')
    } catch {}
  }

  get(keyPath) {
    if (!keyPath) return this.data
    return String(keyPath)
      .split('.')
      .reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), this.data)
  }

  set(keyPath, value) {
    const parts = String(keyPath).split('.')
    let cur = this.data
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]
      if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {}
      cur = cur[p]
    }
    cur[parts[parts.length - 1]] = value
    this.save()
  }

  delete(keyPath) {
    const parts = String(keyPath).split('.')
    let cur = this.data
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur || typeof cur !== 'object') return
      cur = cur[parts[i]]
    }
    if (cur && typeof cur === 'object') {
      delete cur[parts[parts.length - 1]]
      this.save()
    }
  }
}

const store = new JsonDotStore(join(__dirname, 'trafficermc-store.json'))

// =============================================================================
// 2. ELECTRON IPC & BROWSER WINDOW SHIM FOR WEB DASHBOARD
// =============================================================================
const sseClients = new Set()
function broadcastToRenderer(channel, ...args) {
  const payload = JSON.stringify({ channel, args })
  for (const res of sseClients) {
    try {
      res.write(`data: ${payload}\n\n`)
    } catch {
      sseClients.delete(res)
    }
  }
}
setRendererSender(broadcastToRenderer)

const ipcMain = new EventEmitter()
const mainWindow = {
  isMaximized: () => true,
  show: () => {},
  webContents: {
    send: (channel, ...args) => broadcastToRenderer(channel, ...args)
  }
}
const BrowserWindow = {
  getAllWindows: () => [mainWindow]
}

// =============================================================================
// 3. EXACT TRAFFICERMC BOT & AUTH CODE (from src/main/index.js)
// =============================================================================
const botApi = new EventEmitter()
botApi.setMaxListeners(0)

const profilesFolder = path.resolve(process.cwd(), process.env.AUTH_CACHE_DIR || './minecraft-profiles')
if (!fs.existsSync(profilesFolder)) {
  fs.mkdirSync(profilesFolder, { recursive: true })
}

let stopBot = false
let stopScript = false
let stopProxyTest = false
let currentProxy = 0
let proxyUsed = 0

function storeinfo() {
  const config = store.get('config') || {}
  return {
    ...config,
    value: config.value || {},
    boolean: config.boolean || {}
  }
}

function safeStringify(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value) === '[object Object]' ? '' : String(value)
  }
}

let clientVersion = 3.1
let playerList = []
const activeBots = new Map()

function inventorySnapshot(bot) {
  const serializeItem = (item) => {
    if (!item) return null
    return {
      name: item.name,
      displayName: item.displayName,
      count: item.count,
      lore: extractLore(item)
    }
  }

  const opened = bot.currentWindow
  const openWindow =
    opened && opened !== bot.inventory
      ? {
          id: opened.id,
          title: friendlyWindowTitle(opened.title, opened.type),
          type: opened.type,
          slots: opened.slots.slice(0, opened.inventoryStart).map(serializeItem)
        }
      : null

  return {
    username: bot._client.username,
    inventory: bot.inventory.slots.slice(9, 36).map(serializeItem),
    hotbar: bot.inventory.slots.slice(36, 45).map(serializeItem),
    offhand: serializeItem(bot.inventory.slots[45]),
    selectedSlot: bot.quickBarSlot,
    openWindow,
    windowId: opened ? opened.id : bot.inventory.id
  }
}

function sendInventory(bot) {
  if (!bot?._client?.username || !bot.inventory?.slots) return
  sendEvent(bot._client.username, 'inventory', inventorySnapshot(bot))
}

ipcMain.on('loaded', () => {
  store.set('version', {
    current: clientVersion
  })
  mainWindow.webContents.send('windowMaximized', mainWindow.isMaximized())
  mainWindow.webContents.send('setConfig', store.get('config'), store.get('version'))
  mainWindow.webContents.send('accountPresets', store.get('accountPresets') || [])
  if (!store.get('config')) {
    mainWindow.webContents.send('initConfig')
  }
  if (store.get('config.namefile')) {
    mainWindow.webContents.send('fileSelected', 'nameFileLabel', store.get('config.namefile'))
  }
  // Also hydrate any active bots so refreshing the web dashboard restores the bot list & inventory
  activeBots.forEach((bot) => {
    sendEvent(bot._client.username, 'login')
    sendInventory(bot)
  })
})

ipcMain.on('playerList', (event, list) => {
  playerList = list
})

ipcMain.on('setConfig', (event, type, id, value) => {
  store.set(`config.${type}.${id}`, value)
})

ipcMain.on('deleteConfig', () => {
  store.delete('config')
})

ipcMain.on('saveAccountPresets', (event, presets) => {
  store.set('accountPresets', presets)
})

ipcMain.on('addMicrosoftAccount', async (event, { requestId }) => {
  if (!requestId) return
  try {
    const flow = new Authflow(requestId, profilesFolder, undefined, (response) => {
      event.sender.send('microsoftAuth', {
        requestId,
        status: 'code',
        code: response.user_code
      })
    })
    const result = await flow.getMinecraftJavaToken({ fetchProfile: true })
    const profile = result.profile || {}
    event.sender.send('microsoftAuth', {
      requestId,
      status: 'success',
      accountId: requestId,
      name: profile.name || 'Microsoft Account',
      profileId: profile.id || ''
    })
  } catch (error) {
    console.log(error)
    event.sender.send('microsoftAuth', {
      requestId,
      status: 'error',
      message: error.message
    })
  }
})

ipcMain.on('getBotInventory', (event, username) => {
  const bot = activeBots.get(username)
  if (bot) {
    event.sender.send('botEvent', {
      id: username,
      event: 'inventory',
      message: inventorySnapshot(bot)
    })
  }
})

ipcMain.on('clickWindowSlot', (event, username, windowId, slot, mouseButton, mode) => {
  const bot = activeBots.get(username)
  const parsedSlot = Number(slot)
  const parsedMouseButton = Number(mouseButton) || 0
  const parsedMode = Number(mode) || 0
  if (!bot || !Number.isInteger(parsedSlot) || parsedSlot < 0) return
  const activeWindowId = bot.currentWindow ? bot.currentWindow.id : bot.inventory.id
  if (Number(windowId) !== activeWindowId) return
  bot
    .clickWindow(parsedSlot, parsedMouseButton, parsedMode)
    .catch((error) => console.log('clickWindow error:', error.message))
})

ipcMain.on('closeBotWindow', (event, username) => {
  const bot = activeBots.get(username)
  const window = bot?.currentWindow
  if (!bot || !window || window === bot.inventory) return
  bot.closeWindow(window)
  sendInventory(bot)
})

ipcMain.on('setBotHotbar', (event, username, slot) => {
  const bot = activeBots.get(username)
  const parsedSlot = Number(slot)
  if (!bot || !Number.isInteger(parsedSlot) || parsedSlot < 0 || parsedSlot > 8) return
  bot.setQuickBarSlot(parsedSlot)
  sendInventory(bot)
})

ipcMain.on('checkboxClick', (event, id, state) => {
  switch (id) {
    case 'test':
      console.log(state)
      break
    default:
  }
})

ipcMain.on('btnClick', (event, btn) => {
  switch (btn) {
    case 'btnStart':
      connectBot()
      break
    case 'btnStop':
      stopBot = true
      notify('Info', 'Stopped sending bots.', 'success')
      break
    case 'btnChat':
      exeAll('chat ' + storeinfo().value.chatMsg)
      break
    case 'btnDisconnect':
      exeAll('disconnect')
      break
    case 'btnSetHotbar':
      exeAll('sethotbar ' + storeinfo().value.hotbarSlot)
      break
    case 'btnUseheld':
      exeAll('useheld')
      break
    case 'btnPathfinderRun':
      exeAll('pathfinder ' + storeinfo().value.pathFinderCommand)
      break
    case 'btnWinClickRight':
      exeAll('winclick ' + storeinfo().value.invSlot + ' 1')
      break
    case 'btnWinClickLeft':
      exeAll('winclick ' + storeinfo().value.invSlot + ' 0')
      break
    case 'btnDropSlot':
      exeAll('drop ' + storeinfo().value.invSlot)
      break
    case 'btnDropAll':
      exeAll('dropall')
      break
    case 'btnCloseWindow':
      exeAll('closewindow')
      break
    case 'btnStartMove':
      exeAll('startmove ' + storeinfo().value.moveType)
      break
    case 'btnStopMove':
      exeAll('stopmove ' + storeinfo().value.moveType)
      break
    case 'btnResetMove':
      exeAll('resetmove')
      break
    case 'btnLook':
      exeAll('look ' + storeinfo().value.lookDirection)
      break
    case 'btnAfkOn':
      exeAll('afkon')
      break
    case 'btnAfkOff':
      exeAll('afkoff')
      break
    case 'runScript':
      playerList.forEach((username) => {
        startScript(username)
      })
      break
    case 'stopScript':
      stopScript = true
      break
    case 'proxyTestStart':
      testProxy(storeinfo().value.proxyList)
      break
    case 'proxyTestStop':
      stopProxyTest = true
      proxyEvent('', 'stop', '', '')
      break
    case 'proxyScrape':
      if (storeinfo().value.proxyType === 'none')
        return notify('Error', 'Select proxy type', 'error')
      notify('Info', 'Scraping proxies...', 'success')
      setProxy()
      break
    default:
      break
  }
})

function setProxy() {
  scrapeProxy(storeinfo().value.proxyType)
    .then((result) => {
      proxyEvent('', 'scraped', result, '')
    })
    .catch((err) => {
      console.log(err)
      notify('Error', 'Failed to scrape proxies', 'error')
    })
}

async function testProxy(list) {
  stopProxyTest = false
  const server = storeinfo().value.server
  const [serverHost, serverPort] = (server || '').split(':')
  if (!serverHost) return notify('Error', 'Invalid server address', 'error')
  if (!list) return notify('Error', 'Please enter proxy list', 'error')
  if (storeinfo().value.proxyType === 'none') return notify('Error', 'Select proxy type', 'error')
  notify('Info', 'Testing proxies...', 'success')
  proxyEvent('', 'start', '', '')
  const lines = list.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (stopProxyTest) break
    const count = `${i + 1}/${lines.length}`
    const [host, port, username, password] = lines[i].split(':')
    checkProxy(
      storeinfo().value.proxyType,
      host,
      port,
      username,
      password,
      serverHost,
      serverPort || 25565,
      storeinfo().value.proxyCheckTimeout || 5000
    )
      .then((result) => {
        proxyEvent(result.proxy, 'success', '', count)
      })
      .catch((error) => {
        proxyEvent(error.proxy, 'fail', error.reason, count)
      })
    if (lines.length == i + 1) {
      proxyEvent('', 'stop', '', '')
    }
    await delay(storeinfo().value.proxyCheckDelay || 100)
  }
}

async function startScript(username) {
  stopScript = false
  if (!storeinfo().value.scriptText) return
  const scriptLines = storeinfo().value.scriptText.split(/\r?\n/)
  for (let i = 0; i < scriptLines.length; i++) {
    if (stopScript) break
    const args = scriptLines[i].split(' ')
    const command = args.shift().toLowerCase()
    switch (command) {
      case 'delay':
        await delay(parseInt(args[0]))
        break
      default:
        botApi.emit('botEvent', username, command, args.slice(0))
    }
  }
}

async function exeAll(command) {
  if (!command) return
  const list = playerList
  const cmd = command.split(' ')
  if (list.length == 0) return notify('Error', 'No bots selected', 'error')
  for (let i = 0; i < list.length; i++) {
    botApi.emit('botEvent', list[i], cmd[0], cmd.slice(1))
    if (storeinfo().boolean.isLinear) {
      await delay(storeinfo().value.linearDelay || 100)
    }
  }
  sendEvent('Executed', 'chat', 'Script: ' + command)
}

async function startFile() {
  BrowserWindow.getAllWindows()[0].webContents.send('showBottab')
  const filePath = storeinfo().namefile
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)
  const count = storeinfo().value.botMax || lines.length

  for (let i = 0; i < count; i++) {
    if (stopBot) break
    newBot(getBotInfo(lines[i]))
    await delay(storeinfo().value.joinDelay || 1000)
  }
}

async function connectBot() {
  stopBot = false
  currentProxy = 0
  proxyUsed = 0
  const count = storeinfo().value.botMax || 1

  if (storeinfo().value.nameType === 'file' && storeinfo().namefile) {
    BrowserWindow.getAllWindows()[0].webContents.send('showBottab')
  } else if (storeinfo().value.nameType !== 'file' && storeinfo().value.nameType !== 'default') {
    BrowserWindow.getAllWindows()[0].webContents.send('showBottab')
  }

  for (let i = 0; i < count; i++) {
    if (stopBot) break

    let botInfo

    switch (storeinfo().value.nameType) {
      case 'random':
        botInfo = getBotInfo(salt(10))
        break
      case 'legit':
        botInfo = getBotInfo(genName())
        break
      case 'file':
        if (!storeinfo().namefile) {
          notify('Error', 'Please select name file', 'error')
        } else {
          startFile()
        }
        return
      case 'acclist': {
        const presetId = storeinfo().value.accListPreset
        const presets = store.get('accountPresets') || []
        const preset = presets.find((p) => p.id === presetId)
        if (!preset) return notify('Error', 'Please select an account preset', 'error')
        const accounts = preset.accounts.split(/\r?\n/).filter((a) => a.trim())
        if (accounts.length === 0)
          return notify('Error', 'The selected preset has no accounts', 'error')
        const joinCount = Math.min(storeinfo().value.botMax || accounts.length, accounts.length)
        BrowserWindow.getAllWindows()[0].webContents.send('showBottab')
        for (let j = 0; j < joinCount; j++) {
          if (stopBot) break
          newBot(getBotInfo(accounts[j].trim(), preset.authType))
          await delay(storeinfo().value.joinDelay || 1000)
        }
        return
      }
      default:
        if (!storeinfo().value.username) return notify('Error', 'Please insert username', 'error')
        const username =
          count == 1 ? storeinfo().value.username : storeinfo().value.username + '_' + i
        botInfo = getBotInfo(username)
        if (i == 0) BrowserWindow.getAllWindows()[0].webContents.send('showBottab')
    }

    newBot(botInfo)
    await delay(storeinfo().value.joinDelay || 1000)
  }
}

function getBotInfo(botName, authOverride) {
  const server = storeinfo().value.server || 'donutsmp.net:25565'
  const [serverHost, serverPort] = server.split(':')
  const parsedPort = parseInt(serverPort) || 25565

  const options = {
    host: serverHost,
    port: parsedPort,
    username: botName,
    version: storeinfo().value.version || '1.20.4',
    auth: authOverride || storeinfo().value.authType || 'microsoft',
    hideErrors: true,
    joinMessage: storeinfo().value.joinMessage,
    keepAlive: true,
    checkTimeoutInterval: Math.max(300000, parseInt(storeinfo().value.keepAliveTimeout) || 300000),
    brand: getSpoofOptions().brand,
    ...botMode(storeinfo().value.botMode),
    ...getProxy(storeinfo().value.proxyType)
  }

  if (options.auth === 'easymc') {
    options.auth = easyMcAuth
    options.sessionServer = 'https://sessionserver.easymc.io'
  }

  if (options.auth === 'microsoft') {
    options.profilesFolder = profilesFolder
  }

  return options
}

function getSpoofOptions() {
  const info = storeinfo()
  const spoofMode = info.value.spoofMode || 'off'
  const customClient = (info.value.spoofCustomClient || '').trim()
  const hideMods = Boolean(info.boolean.spoofHideMods)
  const channels = (info.value.spoofPayloadChannels || '')
    .split(/\r?\n|,/)
    .map((channel) => channel.trim())
    .filter(Boolean)

  let brand = 'vanilla'
  if (spoofMode === 'modded') {
    brand = 'fabric'
  } else if (spoofMode === 'custom') {
    brand = customClient || 'vanilla'
  }

  return { spoofMode, hideMods, channels, brand }
}

function applySpoof(bot) {
  const spoof = getSpoofOptions()
  if (spoof.spoofMode === 'off') return

  if (spoof.hideMods) {
    const allowedChannels = new Set([
      'MC|Brand',
      'minecraft:brand',
      'REGISTER',
      'UNREGISTER',
      'minecraft:register',
      'minecraft:unregister',
      ...spoof.channels
    ])
    const originalWriteChannel = bot._client.writeChannel.bind(bot._client)
    bot._client.writeChannel = (channel, params) => {
      if (!allowedChannels.has(channel)) return
      return originalWriteChannel(channel, params)
    }
  }
}

function getProxy(proxyType) {
  if (!proxyType || proxyType === 'none' || !storeinfo().value.proxyList) return

  const proxyList = storeinfo().value.proxyList.split(/\r?\n/)
  const randomIndex = crypto.randomInt(0, proxyList.length)
  const proxyPerBot = storeinfo().value.proxyPerBot

  if (proxyUsed >= proxyPerBot) {
    proxyUsed = 0
    currentProxy++
    if (currentProxy >= proxyList.length) {
      currentProxy = 0
    }
  }

  proxyUsed++

  const index = storeinfo().boolean.randomizeOrder ? randomIndex : currentProxy
  const [host, port, username, password] = proxyList[index].split(':')
  return {
    protocol: proxyType,
    proxyHost: host,
    proxyPort: port,
    proxyUsername: username,
    proxyPassword: password
  }
}

function newBot(options) {
  let bot
  let manualDisconnect = false
  let wasKicked = false
  let lastConnectionError = ''

  if (options.auth === 'easymc') {
    if (options.easyMcToken?.length !== 20) {
      return sendEvent(options.username, 'easymcAuth')
    }
    options.auth = easyMcAuth
    options.sessionServer ||= 'https://sessionserver.easymc.io'
  }

  const connectProxy = async (client) => {
    try {
      const socket = await connection(
        storeinfo().value.proxyType,
        options.proxyHost,
        options.proxyPort,
        options.proxyUsername,
        options.proxyPassword,
        options.host,
        options.port
      )
      client.setSocket(socket)
      client.emit('connect')
    } catch (error) {
      if (storeinfo().boolean.proxyLogChat) {
        sendEvent(
          client.username,
          'chat',
          options.proxyHost + ':' + options.proxyPort + ' ' + error
        )
      }
      return
    }
  }

  if (storeinfo().value.proxyType && storeinfo().value.proxyType !== 'none') {
    options.connect = connectProxy
  }

  bot = mineflayer.createBot({
    ...options,
    plugins: {
      anvil: false,
      book: false,
      boss_bar: false,
      breath: false,
      chest: true,
      command_block: false,
      craft: false,
      creative: false,
      enchantment_table: false,
      experience: false,
      explosion: false,
      fishing: false,
      furnace: false,
      generic_place: false,
      painting: false,
      particle: false,
      place_block: false,
      place_entity: false,
      rain: false,
      ray_trace: false,
      scoreboard: false,
      sound: false,
      spawn_point: false,
      tablist: false,
      team: false,
      time: false,
      title: false,
      villager: false
    },
    onMsaCode: (data) => {
      sendEvent(options.username, 'authmsg', data.user_code)
    }
  })
  applySpoof(bot)
  bot._client.on('connect', () => {
    const socket = bot._client.socket
    socket?.setKeepAlive?.(true, 30000)
    socket?.setNoDelay?.(true)
  })
  bot.on('error', (error) => {
    lastConnectionError = error?.message || String(error)
  })
  bot.loadPlugin(pathfinder)
  bot.on('goal_reached', () => {
    sendEvent(bot._client.username, 'chat', 'Pathfinder: goal reached')
  })

  let hitTimer = 0

  bot.once('login', () => {
    activeBots.set(bot._client.username, bot)
    sendEvent(bot._client.username, 'login')
    if (storeinfo().boolean.runOnConnect) {
      startScript(bot._client.username)
    }
    if (storeinfo().value.joinMessage) {
      bot.chat(storeinfo().value.joinMessage)
    }
  })
  bot.once('spawn', () => {
    bot.loadPlugin(antiafk)
    bot.pathfinder.setMovements(new Movements(bot))
    sendInventory(bot)
    bot.inventory.on('updateSlot', () => sendInventory(bot))
    // Trigger any pending Bluxmart auto-deliveries as soon as the bot spawns
    queueManager.processNext()
  })
  bot.on('spawn', () => {
    if (storeinfo().boolean.runOnSpawn) {
      startScript(bot._client.username)
    }
  })
  bot.on('messagestr', (msg) => {
    sendEvent(bot._client.username, 'chat', msg)
  })
  bot.on('windowOpen', (window) => {
    if (!window) return
    sendInventory(bot)
    window.on('updateSlot', () => sendInventory(bot))
    sendEvent(
      bot._client.username,
      'chat',
      `Window Opened : ${friendlyWindowTitle(window.title, window.type)}`
    )
  })
  bot.on('windowClose', () => {
    setTimeout(() => sendInventory(bot), 0)
  })
  bot.once('kicked', (reason) => {
    wasKicked = true
    activeBots.delete(bot._client.username)
    botApi.off('botEvent', botEventHandler)
    let parsedReason = reason
    if (typeof reason === 'string') {
      try {
        parsedReason = JSON.parse(reason)
      } catch {
        parsedReason = reason
      }
    }
    const readableReason =
      flattenTextComponent(parsedReason).trim() ||
      cleanText(parsedReason).trim() ||
      safeStringify(parsedReason) ||
      'Disconnected by server'
    sendEvent(bot._client.username, 'kicked', readableReason)
  })
  bot.once('end', (reason) => {
    activeBots.delete(bot._client.username)
    botApi.off('botEvent', botEventHandler)
    const detailedReason =
      reason === 'socketClosed' && lastConnectionError
        ? `${reason}: ${lastConnectionError}`
        : reason
    const unexpectedSocketClose = reason === 'socketClosed' && !manualDisconnect && !wasKicked
    const reconnecting = storeinfo().boolean.autoReconnect || unexpectedSocketClose
    if (!wasKicked || reconnecting) {
      sendEvent(
        bot._client.username,
        reconnecting ? 'reconnecting' : 'end',
        reconnecting ? 'Connection interrupted; reconnecting…' : detailedReason
      )
    }
    if (reconnecting) {
      const reconnectOptions = { ...options }
      setTimeout(
        () => {
          newBot(reconnectOptions)
        },
        Math.max(1000, Number(storeinfo().value.reconnectDelay) || 1000)
      )
    }
  })

  bot.on('physicTick', () => {
    if (storeinfo().boolean.killauraToggle && playerList.includes(bot._client.username)) {
      killaura()
    }
  })

  function killaura() {
    if (hitTimer <= 0) {
      hit(
        storeinfo().boolean.targetPlayer,
        storeinfo().boolean.targetVehicle,
        storeinfo().boolean.targetMob,
        storeinfo().boolean.targetAnimal,
        storeinfo().value.killauraRange,
        storeinfo().boolean.killauraRotate
      )
      hitTimer = storeinfo().value.killauraDelay || 10
    } else {
      hitTimer--
    }
  }

  function hit(player, vehicle, mob, animal, maxDistance, rotate) {
    let targetEntities = []
    const entities = Object.values(bot.entities)
    entities.forEach((entity) => {
      const distance = bot.entity.position.distanceTo(entity.position)
      if (distance >= parseFloat(maxDistance)) return
      if (entity.type === 'player' && entity.username !== bot.username && player) {
        targetEntities.push(entity)
      }
      if (entity.kind === 'Vehicles' && vehicle) {
        targetEntities.push(entity)
      }
      if (entity.kind === 'Hostile mobs' && mob) {
        targetEntities.push(entity)
      }
      if (entity.kind === 'Passive mobs' && animal) {
        targetEntities.push(entity)
      }
    })
    targetEntities.forEach((entity) => {
      if (rotate) {
        bot.lookAt(entity.position, true)
        bot.attack(entity)
      } else {
        bot.attack(entity)
      }
    })
  }

  const botEventHandler = (target, event, ...options) => {
    if (target !== bot._client.username) return
    const optionsArray = options[0]
    switch (event) {
      case 'disconnect':
        manualDisconnect = true
        bot.quit()
        break
      case 'chat':
        const bypass = storeinfo().boolean.bypassChat ? ' ' + salt(crypto.randomInt(2, 6)) : ''
        bot.chat(
          optionsArray
            .join(' ')
            .replaceAll('{random}', salt(4))
            .replaceAll('{player}', bot._client.username) + bypass
        )
        break
      case 'notify':
        notify(
          'Bot',
          bot._client.username +
            ': ' +
            optionsArray
              .join(' ')
              .replaceAll('{random}', salt(4))
              .replaceAll('{player}', bot._client.username),
          'success'
        )
        break
      case 'sethotbar':
        bot.setQuickBarSlot(parseInt(optionsArray[0] ? optionsArray[0] : 0))
        sendInventory(bot)
        break
      case 'useheld':
        bot.activateItem()
        break
      case 'winclick':
        bot.clickWindow(parseInt(optionsArray[0]), parseInt(optionsArray[1]), 0)
        break
      case 'drop':
        bot.clickWindow(-999, 0, 0)
        bot.clickWindow(parseInt(optionsArray[0]), 0, 0)
        bot.clickWindow(-999, 0, 0)
        break
      case 'dropall':
        ;(async () => {
          const itemCount = bot.inventory.items().length
          for (var i = 0; i < itemCount; i++) {
            if (bot.inventory.items().length === 0) return
            const item = bot.inventory.items()[0]
            bot.tossStack(item)
            await delay(10)
          }
        })()
        break
      case 'closewindow':
        bot.closeWindow(bot.currentWindow || '')
        break
      case 'startmove':
        bot.setControlState(optionsArray[0], true)
        break
      case 'stopmove':
        bot.setControlState(optionsArray[0], false)
        break
      case 'resetmove':
        bot.clearControlStates()
        break
      case 'look':
        bot.look(parseFloat(optionsArray[0]), 0, true)
        break
      case 'pathfinder':
        runPathfinder(optionsArray)
        break
      case 'afkon':
        bot.afk.start()
        break
      case 'afkoff':
        bot.afk.stop()
        break
      case 'hit':
        const player = optionsArray[0]
        const vehicle = optionsArray[1]
        const mob = optionsArray[2]
        const animal = optionsArray[3]
        const maxDistance = parseFloat(optionsArray[4])
        const rotate = optionsArray[5]
        hit(player, vehicle, mob, animal, maxDistance, rotate)
        break
      default:
    }
  }
  botApi.on('botEvent', botEventHandler)

  function runPathfinder(args) {
    const command = String(args.shift() || '').toLowerCase()
    const coordinates = args.map(Number)
    if (command !== 'stop') bot.physicsEnabled = true
    switch (command) {
      case 'goto':
        if (
          coordinates.length < 3 ||
          coordinates.slice(0, 3).some((value) => !Number.isFinite(value))
        ) {
          return sendEvent(bot._client.username, 'chat', 'Pathfinder: use goto X Y Z')
        }
        bot.pathfinder.setGoal(
          new GoalBlock(
            Math.floor(coordinates[0]),
            Math.floor(coordinates[1]),
            Math.floor(coordinates[2])
          )
        )
        sendEvent(
          bot._client.username,
          'chat',
          `Pathfinder: moving to ${coordinates.slice(0, 3).join(' ')}`
        )
        break
      case 'near':
        if (
          coordinates.length < 4 ||
          coordinates.slice(0, 4).some((value) => !Number.isFinite(value))
        ) {
          return sendEvent(bot._client.username, 'chat', 'Pathfinder: use near X Y Z RANGE')
        }
        bot.pathfinder.setGoal(
          new GoalNear(coordinates[0], coordinates[1], coordinates[2], coordinates[3])
        )
        sendEvent(
          bot._client.username,
          'chat',
          `Pathfinder: moving near ${coordinates.slice(0, 3).join(' ')}`
        )
        break
      case 'follow':
        const targetName = args.join(' ')
        const target = bot.players[targetName]?.entity
        if (!target)
          return sendEvent(bot._client.username, 'chat', `Pathfinder: cannot see ${targetName}`)
        bot.pathfinder.setGoal(new GoalFollow(target, 2), true)
        sendEvent(bot._client.username, 'chat', `Pathfinder: following ${targetName}`)
        break
      case 'stop':
        bot.pathfinder.setGoal(null)
        sendEvent(bot._client.username, 'chat', 'Pathfinder: stopped')
        break
      default:
        sendEvent(bot._client.username, 'chat', 'Pathfinder: unknown command')
    }
  }
}

// =============================================================================
// 4. BLUXBOT DISCORD BOT ENGINE (bluxbot-deploy-safe integrated on same server)
// =============================================================================
const {
  startOrRestartDiscordBot,
  syncAllDiscordGuildsNow,
  notifyDiscordOrder,
  getDiscordBotStatus
} = require('./discord-bot/dist/runner.js')

setTimeout(() => {
  startOrRestartDiscordBot({
    token: store.get('discord.token') || process.env.DISCORD_TOKEN || '',
    clientId: store.get('discord.clientId') || process.env.CLIENT_ID || '',
    guildId: store.get('discord.guildId') || process.env.GUILD_ID || ''
  })
}, 1000)

// =============================================================================
// 5. BLUXMART.COM AUTO-DELIVERY SYNC ENGINE (Uses Active TrafficerMC Bot)
// =============================================================================
function getPrimaryDeliveryBot() {
  for (const bot of activeBots.values()) {
    if (bot && bot.entity) return bot
  }
  return activeBots.values().next().value || null
}

const queueManager = new DeliveryQueueManager(getPrimaryDeliveryBot, {
  queueFilePath: path.resolve(process.cwd(), './delivery-queue.json'),
  safetyRadius: Number(process.env.SAFETY_RADIUS_BLOCKS || 5),
  tpaTimeoutMs: Number(process.env.TPA_WAIT_TIMEOUT_MS || 45000),
  onStatusChange: async (order) => {
    const botName = getPrimaryDeliveryBot()?._client?.username || 'Bluxmart'
    sendEvent(botName, 'chat', `[Bluxmart] Order ${order.id} (${order.recipient}) -> ${order.status.toUpperCase()}`)
    await reportStatusToBluxmart(order)
    await notifyDiscordOrder(order)
  }
})

let lastSyncTime = null
let lastSyncError = null
const BLUXMART_SITE_URL = (process.env.BLUXMART_SITE_URL || 'https://bluxmart.com').replace(/\/+$/, '')
const SYNC_SECRET = process.env.WISP_BOT_SECRET || process.env.WEBHOOK_SECRET || 'bluxmart-wisp-secret-2026'

async function reportStatusToBluxmart(order) {
  try {
    await fetch(`${BLUXMART_SITE_URL}/api/bot/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': SYNC_SECRET
      },
      body: JSON.stringify({
        action: 'update',
        id: order.id,
        status: order.status === 'completed' ? 'completed' : order.status === 'failed' ? 'failed' : 'delivering',
        note: order.error || `Delivered by TrafficerMC bot (${getPrimaryDeliveryBot()?._client?.username || 'bot'})`
      })
    })
  } catch {}
}

async function syncWithBluxmartCloud() {
  try {
    const res = await fetch(`${BLUXMART_SITE_URL}/api/bot/sync`, {
      method: 'GET',
      headers: {
        'x-webhook-secret': SYNC_SECRET,
        'Accept': 'application/json'
      }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    lastSyncTime = new Date().toISOString()
    lastSyncError = null
    if (Array.isArray(data.orders)) {
      for (const cloudOrder of data.orders) {
        const exists = queueManager.queue.find((q) => q.id === cloudOrder.id)
        if (!exists && cloudOrder.recipient) {
          notify('Bluxmart Order', `New order for ${cloudOrder.recipient}`, 'success')
          const queued = queueManager.enqueue({
            id: cloudOrder.id,
            recipient: cloudOrder.recipient,
            money: Number(cloudOrder.money || 0),
            spawners: Number(cloudOrder.spawners || 0),
            elytras: Number(cloudOrder.elytras || 0),
            requiresInGame: Boolean(cloudOrder.requiresInGame)
          })
          await reportStatusToBluxmart({ id: cloudOrder.id, status: 'processing' })
          await notifyDiscordOrder(queued)
        }
      }
    }
  } catch (err) {
    lastSyncError = err.message
  }
}

setInterval(syncWithBluxmartCloud, 5000)
setTimeout(syncWithBluxmartCloud, 1500)

// =============================================================================
// 6. NATIVE HTTP WEB SERVER (Serves Full TrafficerMC + Bluxmart + Discord UI)
// =============================================================================
const rendererDir = fs.existsSync(path.join(__dirname, 'renderer'))
  ? path.join(__dirname, 'renderer')
  : path.resolve(__dirname, '../out/renderer')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2'
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const pathname = decodeURIComponent(urlObj.pathname)

  if (req.method === 'GET' && pathname === '/api/ipc/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  if (req.method === 'POST' && pathname === '/api/ipc/send') {
    const body = await readJsonBody(req)
    const { channel, args = [] } = body || {}
    if (!channel) return sendJson(res, 400, { error: 'Missing IPC channel' })
    ipcMain.emit(channel, { sender: mainWindow.webContents }, ...args)
    return sendJson(res, 200, { ok: true })
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    const primaryBot = getPrimaryDeliveryBot()
    return sendJson(res, 200, {
      ok: true,
      bot: {
        connected: Boolean(primaryBot && primaryBot.entity),
        username: primaryBot?._client?.username || primaryBot?.username || null,
        activeCount: activeBots.size,
        activeUsernames: Array.from(activeBots.keys()),
        host: storeinfo().value.server || 'donutsmp.net:25565'
      },
      sync: {
        siteUrl: BLUXMART_SITE_URL,
        lastSyncAt: lastSyncTime,
        lastError: lastSyncError
      },
      discord: getDiscordBotStatus(),
      queue: queueManager.queue
    })
  }

  if (req.method === 'POST' && pathname === '/api/discord/config') {
    const body = await readJsonBody(req)
    if (body.token) store.set('discord.token', String(body.token).trim())
    if (body.clientId !== undefined) store.set('discord.clientId', String(body.clientId).trim())
    if (body.guildId !== undefined) store.set('discord.guildId', String(body.guildId).trim())
    const result = await startOrRestartDiscordBot({
      token: store.get('discord.token') || process.env.DISCORD_TOKEN || '',
      clientId: store.get('discord.clientId') || process.env.CLIENT_ID || '',
      guildId: store.get('discord.guildId') || process.env.GUILD_ID || ''
    })
    return sendJson(res, 200, { ...result, discord: getDiscordBotStatus() })
  }

  if (req.method === 'POST' && pathname === '/api/discord/sync') {
    const result = await syncAllDiscordGuildsNow()
    return sendJson(res, 200, { ...result, discord: getDiscordBotStatus() })
  }

  if (req.method === 'POST' && pathname === '/api/sync-now') {
    await syncWithBluxmartCloud()
    return sendJson(res, 200, { ok: true, lastSyncAt: lastSyncTime, lastError: lastSyncError })
  }

  if (req.method === 'POST' && pathname === '/api/deliver') {
    const body = await readJsonBody(req)
    const { id, recipient, money = 0, spawners = 0, elytras = 0 } = body || {}
    if (!recipient || typeof recipient !== 'string') {
      return sendJson(res, 400, { error: 'Missing or invalid Minecraft recipient username' })
    }
    const order = queueManager.enqueue({ id, recipient: recipient.trim(), money, spawners, elytras })
    await notifyDiscordOrder(order)
    return sendJson(res, 202, { ok: true, message: 'Order added to delivery queue', order })
  }

  if (req.method === 'POST' && pathname === '/api/order/action') {
    const body = await readJsonBody(req)
    const { id, action } = body || {}
    const idx = queueManager.queue.findIndex((o) => o.id === id)
    if (idx === -1) return sendJson(res, 404, { error: 'Order not found' })
    if (action === 'retry') {
      queueManager.queue[idx].status = 'queued'
      queueManager.queue[idx].error = null
      queueManager.saveQueue()
      queueManager.processNext()
    } else if (action === 'delete') {
      queueManager.queue.splice(idx, 1)
      queueManager.saveQueue()
    } else if (action === 'complete') {
      queueManager.queue[idx].status = 'completed'
      queueManager.saveQueue()
      reportStatusToBluxmart(queueManager.queue[idx])
      notifyDiscordOrder(queueManager.queue[idx])
    }
    return sendJson(res, 200, { ok: true, queue: queueManager.queue })
  }

  const relPath = pathname === '/' ? '/index.html' : pathname
  const safePath = path.normalize(path.join(rendererDir, relPath))
  if (safePath.startsWith(rendererDir) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
    const ext = path.extname(safePath).toLowerCase()
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' })
    fs.createReadStream(safePath).pipe(res)
    return
  }

  // 7. Forward Bluxbot Discord Admin Console routes (/discord-admin, /login, /logout, /styles.css, /app.js, /api/me, /api/guilds, /api/template, /api/change-password) to local port 3001 so everything works on a single Wispbyte port!
  const discordAdminPort = Number(process.env.DASHBOARD_PORT || 3001)
  const targetPath = pathname === '/discord-admin' || pathname === '/discord-admin/'
    ? '/'
    : pathname.startsWith('/discord-admin/')
      ? pathname.slice('/discord-admin'.length)
      : pathname
  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: discordAdminPort,
      path: targetPath + (urlObj.search || ''),
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${discordAdminPort}` }
    },
    (proxyRes) => {
      const headers = { ...proxyRes.headers }
      delete headers['content-security-policy']
      delete headers['x-frame-options']
      res.writeHead(proxyRes.statusCode || 200, headers)
      proxyRes.pipe(res)
    }
  )
  proxyReq.on('error', () => {
    sendJson(res, 404, { error: 'Not Found' })
  })
  req.pipe(proxyReq)
})

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Wispbyte] Unified TrafficerMC + Bluxmart Auto-Delivery + Bluxbot Discord Server listening on http://0.0.0.0:${PORT}`)
})

process.on('uncaughtException', (err) => {
  console.log(err)
})
process.on('UnhandledPromiseRejectionWarning', (err) => {
  console.log(err)
})

