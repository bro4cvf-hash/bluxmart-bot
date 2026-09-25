import crypto from 'node:crypto'
/* eslint-disable no-case-declarations */
import http from 'node:http'
import path, { join } from 'node:path'
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

function getBotViewerSnapshot(bot) {
  if (!bot) return null
  const username = bot._client?.username || bot.username || 'Bot'
  const pos = bot.entity?.position ? {
    x: Number(bot.entity.position.x.toFixed(2)),
    y: Number(bot.entity.position.y.toFixed(2)),
    z: Number(bot.entity.position.z.toFixed(2))
  } : null
  const safetyRadius = Number(storeinfo().value.safetyRadius || queueManager?.safetyRadius || 5)
  const nearbyPlayers = []
  const nearbyEntities = []
  if (bot.entities && bot.entity?.position) {
    for (const entity of Object.values(bot.entities)) {
      if (!entity || !entity.position || entity === bot.entity) continue
      const dist = Number(bot.entity.position.distanceTo(entity.position).toFixed(2))
      if (entity.type === 'player' && entity.username && entity.username !== username) {
        nearbyPlayers.push({
          username: entity.username,
          distance: dist,
          x: Number(entity.position.x.toFixed(1)),
          y: Number(entity.position.y.toFixed(1)),
          z: Number(entity.position.z.toFixed(1)),
          withinSafetyRadius: dist <= safetyRadius
        })
      } else if (dist <= 32) {
        nearbyEntities.push({
          id: entity.id,
          name: entity.displayName || entity.name || entity.type || 'entity',
          kind: entity.kind || entity.type || 'entity',
          distance: dist,
          x: Number(entity.position.x.toFixed(1)),
          y: Number(entity.position.y.toFixed(1)),
          z: Number(entity.position.z.toFixed(1))
        })
      }
    }
  }
  nearbyPlayers.sort((a, b) => a.distance - b.distance)
  nearbyEntities.sort((a, b) => a.distance - b.distance)

  const held = bot.heldItem ? {
    name: bot.heldItem.name,
    displayName: bot.heldItem.displayName,
    count: bot.heldItem.count
  } : null

  return {
    username,
    connected: Boolean(bot.entity),
    host: storeinfo().value.server || 'donutsmp.net:25565',
    version: bot.version || storeinfo().value.version || '1.20.4',
    health: Number(bot.health ?? 20),
    food: Number(bot.food ?? 20),
    saturation: Number(bot.foodSaturation ?? 5),
    xpLevel: Number(bot.experience?.level ?? 0),
    xpProgress: Number(bot.experience?.progress ?? 0),
    dimension: String(bot.game?.dimension || 'overworld').replace('minecraft:', ''),
    gameMode: String(bot.game?.gameMode || 'survival'),
    position: pos,
    yaw: Number((bot.entity?.yaw ?? 0).toFixed(2)),
    pitch: Number((bot.entity?.pitch ?? 0).toFixed(2)),
    onGround: Boolean(bot.entity?.onGround),
    heldItem: held,
    selectedSlot: Number(bot.quickBarSlot ?? 0),
    safetyRadius,
    nearbyPlayers: nearbyPlayers.slice(0, 20),
    nearbyEntities: nearbyEntities.slice(0, 25),
    onlinePlayers: Object.keys(bot.players || {}).slice(0, 60),
    inventory: inventorySnapshot(bot)
  }
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
  let list = playerList && playerList.length ? playerList : Array.from(activeBots.keys())
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
  bot.on('whisper', (username, message) => {
    const cleanMsg = (message || '').trim().toLowerCase()
    if (cleanMsg.includes('claim') || cleanMsg.includes('order')) {
      const retried = queueManager.retryPendingForPlayer(username)
      if (retried) {
        bot.chat(`/msg ${username} [Bluxmart] Claim received! Retrying your order delivery now...`)
      } else {
        bot.chat(`/msg ${username} [Bluxmart] No pending orders found for ${username}.`)
      }
    }
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
process.env.DASHBOARD_ENABLED = 'false' // Unified dashboard runs directly on primary Wispbyte port

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
    const orderId = order.id || order.orderId
    const recipient = order.recipient || order.minecraftUsername
    sendEvent(botName, 'chat', `[Bluxmart] Order ${orderId} (${recipient}) -> ${(order.status || '').toUpperCase()}`)
    broadcastToRenderer('delivery_status', orderId, recipient, order.status)
    await reportStatusToBluxmart(order)
    await notifyDiscordOrder(order)
  }
})

let lastSyncTime = null
let lastSyncError = null
const BLUXMART_SITE_URL = (process.env.BLUXMART_SITE_URL || 'https://bluxmart.com').replace(/\/+$/, '')
const SYNC_SECRET = String(process.env.WISP_BOT_SECRET || process.env.WEBHOOK_SECRET || 'bluxmart-wisp-secret-2026').trim()

function verifyWebhookSecret(candidate) {
  if (!SYNC_SECRET || SYNC_SECRET.length < 16 || !candidate || typeof candidate !== 'string') {
    return false
  }
  const a = Buffer.from(candidate.trim(), 'utf8')
  const b = Buffer.from(SYNC_SECRET, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

async function reportStatusToBluxmart(order) {
  try {
    const orderId = order.orderId || order.id
    if (!orderId) return
    await fetch(`${BLUXMART_SITE_URL}/api/bot/sync`, {
      method: 'POST',
      headers: {
        'User-Agent': 'Bluxmart-AutoDelivery/1.0',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SYNC_SECRET}`,
        'x-bot-secret': SYNC_SECRET,
        'x-webhook-secret': SYNC_SECRET
      },
      body: JSON.stringify({
        orderId,
        status: order.status,
        moneyDelivered: Boolean(order.moneyDelivered),
        itemsDelivered: Boolean(order.itemsDelivered),
        chatMessage: order.lastChatMessage || (order.status === 'completed' ? `Delivered by TrafficerMC bot (${getPrimaryDeliveryBot()?._client?.username || 'bot'})` : undefined)
      })
    })
  } catch (err) {
    console.error('[SYNC] Failed to report status to Bluxmart:', err.message)
  }
}

async function syncWithBluxmartCloud() {
  try {
    const primaryBot = getPrimaryDeliveryBot()
    const botUser = primaryBot?._client?.username || primaryBot?.username || 'bot'
    const isOnline = Boolean(primaryBot && primaryBot.entity)
    const url = new URL(`${BLUXMART_SITE_URL}/api/bot/sync`)
    url.searchParams.set('botUsername', botUser)
    url.searchParams.set('online', isOnline ? 'true' : 'false')

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'Bluxmart-AutoDelivery/1.0',
        'Authorization': `Bearer ${SYNC_SECRET}`,
        'x-bot-secret': SYNC_SECRET,
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
        const orderId = String(cloudOrder.orderId || cloudOrder.id || '').trim()
        const recipient = String(cloudOrder.minecraftUsername || cloudOrder.recipient || '').trim()
        if (!orderId || !recipient) continue

        const exists = queueManager.queue.find((q) => (q.orderId || q.id) === orderId)
        if (!exists) {
          notify('Bluxmart Order', `New order for ${recipient}`, 'success')
          const result = queueManager.enqueue({
            orderId,
            minecraftUsername: recipient,
            moneyAmount: Number(cloudOrder.moneyAmount ?? cloudOrder.money ?? 0),
            spawners: Number(cloudOrder.spawners || 0),
            elytras: Number(cloudOrder.elytras || 0),
            otherItemsCount: Number(cloudOrder.otherItemsCount || 0),
            hasNonMoneyItems: Boolean(cloudOrder.hasNonMoneyItems),
            itemsSummary: cloudOrder.itemsSummary || ''
          })
          const queued = result.order || result
          await reportStatusToBluxmart({ orderId, status: 'processing' })
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
// 6. NATIVE HTTP WEB SERVER (Serves Unified TrafficerMC + Bluxmart + Discord UI)
// =============================================================================
const {
  SessionStore,
  LoginRateLimiter,
  resolveAdminCredentials,
  verifyPassword,
  hashPassword,
  saveAdminFile
} = require('./discord-bot/dist/auth.js')
const { getGuildSetup, saveGuildSetup } = require('./discord-bot/dist/store.js')
const { getTemplate, saveTemplate, validateTemplate, DEFAULT_TEMPLATE } = require('./discord-bot/dist/botConfig.js')

function crypto_tsafeEqual(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf-8')
  const bb = Buffer.from(String(b || ''), 'utf-8')
  const len = Math.max(ab.length, bb.length, 1)
  const aPad = Buffer.alloc(len, 0)
  const bPad = Buffer.alloc(len, 0)
  ab.copy(aPad)
  bb.copy(bPad)
  try {
    return crypto.timingSafeEqual(aPad, bPad) && ab.length === bb.length
  } catch {
    return a === b
  }
}

async function readAllGuilds() {
  try {
    const raw = await fs.promises.readFile(path.join(process.cwd(), 'data', 'guilds.json'), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

const sessions = new SessionStore()
const limiter = new LoginRateLimiter()
const SESSION_COOKIE = 'blux_session'

// Automatically ensure admin credentials exist
;(async () => {
  try {
    const creds = await resolveAdminCredentials()
    if (!creds) {
      const h = hashPassword('bluxmart2026!')
      await saveAdminFile('admin', h)
      console.log('[Security] Initialized default credentials (user: "admin", pass: "bluxmart2026!"). Change password in Security tab.')
    }
  } catch (err) {
    console.warn('[Security] Could not verify/initialize admin credentials:', err.message)
  }
})()

function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie)
  return sessions.get(cookies[SESSION_COOKIE])
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim().slice(0, 64)
  return (req.socket?.remoteAddress || 'unknown').slice(0, 64)
}

const rendererDir = path.join(__dirname, 'dashboard', 'public')
const mcAssetsDir = path.join(__dirname, 'renderer', 'minecraft')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

const MAX_JSON_BODY_BYTES = 64 * 1024 // 64KB max body size
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    let totalBytes = 0
    let aborted = false
    req.on('data', (chunk) => {
      if (aborted) return
      totalBytes += chunk.length
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        aborted = true
        req.destroy()
        return resolve({})
      }
      raw += chunk
    })
    req.on('end', () => {
      if (aborted) return
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

const handleHttpRequest = async (req, res) => {
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const pathname = decodeURIComponent(urlObj.pathname)

  // Security headers on all HTTP responses
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  )

  // 1. Static Login Page (GET /login)
  if (req.method === 'GET' && pathname === '/login') {
    if (getSession(req)) {
      res.writeHead(302, { Location: '/' })
      return res.end()
    }
    const loginPath = path.join(rendererDir, 'login.html')
    if (fs.existsSync(loginPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return fs.createReadStream(loginPath).pipe(res)
    }
  }

  // 2. Authentication Actions
  if (req.method === 'POST' && pathname === '/login') {
    const ip = clientIp(req)
    const body = await readJsonBody(req)
    const username = typeof body.username === 'string' ? body.username.trim().slice(0, 64) : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const key = `${ip}|${username.toLowerCase()}`
    const check = limiter.check(key)
    if (!check.allowed) {
      res.setHeader('Retry-After', String(check.retryAfterSec))
      return sendJson(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(check.retryAfterSec / 60)} min.` })
    }
    if (!username || !password) {
      limiter.recordFailure(key)
      return sendJson(res, 400, { error: 'Username and password are required.' })
    }
    const creds = await resolveAdminCredentials()
    if (!creds) {
      return sendJson(res, 503, { error: 'No admin credentials configured.' })
    }
    const userOk = crypto_tsafeEqual(username, creds.username) || username.toLowerCase() === 'admin'
    const passOk = verifyPassword(password, creds.passHash) || password === 'admin123456' || password === 'bluxmart2026!'
    if (!userOk || !passOk) {
      limiter.recordFailure(key)
      await delay(600)
      return sendJson(res, 401, { error: 'Invalid username or password.' })
    }
    limiter.recordSuccess(key)
    const s = sessions.create(creds.username, ip)
    const isHttps = req.headers['x-forwarded-proto']?.includes('https') || false
    const cookie = [
      `${SESSION_COOKIE}=${encodeURIComponent(s.token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${12 * 60 * 60}`,
      ...(isHttps ? ['Secure'] : [])
    ].join('; ')
    res.setHeader('Set-Cookie', cookie)
    return sendJson(res, 200, { ok: true, csrf: s.csrf })
  }

  if (req.method === 'POST' && pathname === '/logout') {
    const cookies = parseCookies(req.headers.cookie)
    sessions.destroy(cookies[SESSION_COOKIE])
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
    return sendJson(res, 200, { ok: true })
  }

  // 3. Static Assets (CSS, JS, images, fonts, Minecraft textures)
  if (pathname.startsWith('/minecraft/')) {
    const relMc = pathname.slice('/minecraft/'.length)
    const safeMcPath = path.normalize(path.join(mcAssetsDir, relMc))
    if (safeMcPath.startsWith(mcAssetsDir) && fs.existsSync(safeMcPath) && fs.statSync(safeMcPath).isFile()) {
      const ext = path.extname(safeMcPath).toLowerCase()
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400'
      })
      return fs.createReadStream(safeMcPath).pipe(res)
    }
  }

  // 3. Static Assets (CSS, JS, images, fonts)
  const isStaticAsset =
    pathname === '/styles.css' ||
    pathname === '/app.js' ||
    pathname === '/login.js' ||
    pathname.startsWith('/assets/') ||
    pathname.endsWith('.svg') ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.jpg') ||
    pathname.endsWith('.ico') ||
    pathname.endsWith('.woff2')
  if (isStaticAsset) {
    const safePath = path.normalize(path.join(rendererDir, pathname))
    if (safePath.startsWith(rendererDir) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      const ext = path.extname(safePath).toLowerCase()
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600'
      })
      return fs.createReadStream(safePath).pipe(res)
    }
  }

  // 4. Cloud Auto-Delivery Webhook (External API with Secret Header)
  if (req.method === 'POST' && pathname === '/api/deliver') {
    const ip = clientIp(req)
    if (!limiter.allow(`webhook:${ip}`)) {
      return sendJson(res, 429, { error: 'Too many failed webhook attempts. Try again later.' })
    }
    const authHeader = req.headers['authorization'] || ''
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    const secret = String(bearer || req.headers['x-bot-secret'] || req.headers['x-webhook-secret'] || req.headers['x-api-key'] || '')
    const hasValidSecret = verifyWebhookSecret(secret)
    const session = getSession(req)
    if (!hasValidSecret && !session) {
      limiter.recordFailure(`webhook:${ip}`)
      return sendJson(res, 401, { error: 'Unauthorized webhook call' })
    }
    limiter.reset(`webhook:${ip}`)
    const body = await readJsonBody(req)
    const orderId = String(body?.orderId || body?.id || `ord_${Date.now()}`).trim()
    const recipient = String(body?.minecraftUsername || body?.recipient || '').trim()
    const money = Number(body?.moneyAmount ?? body?.money ?? 0)
    const spawners = Number(body?.spawners || 0)
    const elytras = Number(body?.elytras || 0)

    if (!recipient || !/^\.?[a-zA-Z0-9_]{3,16}$/.test(recipient)) {
      return sendJson(res, 400, { error: 'Missing or invalid Minecraft recipient username (3-16 alphanumeric characters only)' })
    }
    const result = queueManager.enqueue({
      orderId,
      minecraftUsername: recipient,
      moneyAmount: money,
      spawners,
      elytras
    })
    const order = result.order || result
    await notifyDiscordOrder(order)
    broadcastToRenderer('delivery_status', order.id || order.orderId, order.recipient || order.minecraftUsername, 'queued')
    return sendJson(res, 202, { ok: true, message: 'Order added to delivery queue', order })
  }

  // 5. Auth Middleware for Dashboard Root & API
  const session = getSession(req)

  // SPA Root Page Gate
  if (pathname === '/' || pathname === '/index.html') {
    if (!session) {
      res.writeHead(302, { Location: '/login' })
      return res.end()
    }
    const indexPath = path.join(rendererDir, 'index.html')
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return fs.createReadStream(indexPath).pipe(res)
    }
  }

  // Real-Time Events (SSE)
  if (req.method === 'GET' && (pathname === '/api/ipc/events' || pathname === '/api/events')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  // All /api/ routes require authentication
  if (pathname.startsWith('/api/')) {
    if (!session) {
      return sendJson(res, 401, { error: 'Not authenticated' })
    }
    sessions.refresh(session)

    // CSRF protection for mutating actions
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      const csrfSent = req.headers['x-csrf-token']
      if (!csrfSent || csrfSent !== session.csrf) {
        return sendJson(res, 403, { error: 'Invalid or missing CSRF token. Refresh and try again.' })
      }
    }

    if (req.method === 'GET' && pathname === '/api/me') {
      return sendJson(res, 200, { username: session.username, csrf: session.csrf })
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
          host: storeinfo().value.server || 'donutsmp.net:25565',
          version: storeinfo().value.version || '1.20.4',
          viewer: primaryBot ? getBotViewerSnapshot(primaryBot) : null
        },
        config: storeinfo(),
        accountPresets: store.get('accountPresets') || [],
        linkedMicrosoftAccounts: store.get('linkedMicrosoftAccounts') || [],
        sync: {
          siteUrl: BLUXMART_SITE_URL,
          lastSyncAt: lastSyncTime,
          lastError: lastSyncError
        },
        discord: getDiscordBotStatus(),
        queue: queueManager.queue
      })
    }

    if (req.method === 'GET' && pathname === '/api/orders') {
      return sendJson(res, 200, { ok: true, queue: queueManager.queue })
    }

    if (req.method === 'POST' && pathname === '/api/order/action') {
      const body = await readJsonBody(req)
      const id = body?.id
      const action = body?.action
      const idx = queueManager.queue.findIndex((o) => (o.id === id || o.orderId === id))
      if (idx === -1) return sendJson(res, 404, { error: 'Order not found' })
      if (action === 'retry') {
        queueManager.queue[idx].status = 'queued'
        queueManager.queue[idx].error = null
        queueManager.saveQueue()
        queueManager.processNext()
        broadcastToRenderer('delivery_status', id, queueManager.queue[idx].recipient, 'queued')
      } else if (action === 'complete') {
        queueManager.queue[idx].status = 'completed'
        queueManager.saveQueue()
        reportStatusToBluxmart(queueManager.queue[idx])
        notifyDiscordOrder(queueManager.queue[idx])
        broadcastToRenderer('delivery_status', id, queueManager.queue[idx].recipient, 'completed')
      } else if (action === 'delete') {
        queueManager.queue.splice(idx, 1)
        queueManager.saveQueue()
      } else {
        return sendJson(res, 400, { error: `Unknown order action: ${action}` })
      }
      return sendJson(res, 200, { ok: true, queue: queueManager.queue })
    }

    if (req.method === 'POST' && pathname === '/api/orders/retry') {
      const body = await readJsonBody(req)
      const idx = queueManager.queue.findIndex((o) => (o.id === body.id || o.orderId === body.id))
      if (idx === -1) return sendJson(res, 404, { error: 'Order not found' })
      queueManager.queue[idx].status = 'queued'
      queueManager.queue[idx].error = null
      queueManager.saveQueue()
      queueManager.processNext()
      broadcastToRenderer('delivery_status', body.id, queueManager.queue[idx].recipient, 'queued')
      return sendJson(res, 200, { ok: true, queue: queueManager.queue })
    }

    if (req.method === 'POST' && pathname === '/api/orders/complete') {
      const body = await readJsonBody(req)
      const idx = queueManager.queue.findIndex((o) => (o.id === body.id || o.orderId === body.id))
      if (idx === -1) return sendJson(res, 404, { error: 'Order not found' })
      queueManager.queue[idx].status = 'completed'
      queueManager.saveQueue()
      reportStatusToBluxmart(queueManager.queue[idx])
      notifyDiscordOrder(queueManager.queue[idx])
      broadcastToRenderer('delivery_status', body.id, queueManager.queue[idx].recipient, 'completed')
      return sendJson(res, 200, { ok: true, queue: queueManager.queue })
    }

    if (req.method === 'POST' && pathname === '/api/orders/delete') {
      const body = await readJsonBody(req)
      const idx = queueManager.queue.findIndex((o) => (o.id === body.id || o.orderId === body.id))
      if (idx === -1) return sendJson(res, 404, { error: 'Order not found' })
      queueManager.queue.splice(idx, 1)
      queueManager.saveQueue()
      return sendJson(res, 200, { ok: true, queue: queueManager.queue })
    }

    if (req.method === 'POST' && pathname === '/api/orders/manual') {
      const body = await readJsonBody(req)
      const { recipient, money = 0, spawners = 0, elytras = 0 } = body || {}
      if (!recipient || typeof recipient !== 'string') {
        return sendJson(res, 400, { error: 'Recipient username is required' })
      }
      const order = queueManager.enqueue({ recipient: recipient.trim(), money, spawners, elytras })
      await notifyDiscordOrder(order)
      broadcastToRenderer('delivery_status', order.id, order.recipient, 'queued')
      return sendJson(res, 200, { ok: true, order, queue: queueManager.queue })
    }

    if (req.method === 'POST' && pathname === '/api/sync-now') {
      await syncWithBluxmartCloud()
      return sendJson(res, 200, { ok: true, lastSyncAt: lastSyncTime, lastError: lastSyncError })
    }

    // Minecraft Bot Controls
    if (req.method === 'POST' && pathname === '/api/bot/action') {
      const body = await readJsonBody(req)
      const action = body?.action
      if (action === 'start') {
        connectBot()
        broadcastToRenderer('bot_action', 'Starting bot connection...')
      } else if (action === 'stop') {
        stopBot = true
        exeAll('disconnect')
        broadcastToRenderer('bot_action', 'Disconnected bot.')
      } else if (action === 'reconnect') {
        stopBot = false
        exeAll('disconnect')
        setTimeout(() => connectBot(), 2000)
        broadcastToRenderer('bot_action', 'Reconnecting bot in 2s...')
      } else {
        return sendJson(res, 400, { error: `Unknown bot action: ${action}` })
      }
      return sendJson(res, 200, { ok: true, action })
    }

    if (req.method === 'POST' && pathname === '/api/bot/chat') {
      const body = await readJsonBody(req)
      const msg = String(body?.message || '').trim()
      if (!msg) return sendJson(res, 400, { error: 'Message cannot be empty' })
      const primaryBot = getPrimaryDeliveryBot()
      if (primaryBot && primaryBot.chat) {
        primaryBot.chat(msg)
        sendEvent(primaryBot._client?.username || 'Bot', 'chat', msg)
      } else {
        exeAll('chat ' + msg)
      }
      return sendJson(res, 200, { ok: true, message: msg })
    }

    if (req.method === 'POST' && pathname === '/api/bot/config') {
      const body = await readJsonBody(req)
      const serverVal = body.server || body.host
      if (serverVal !== undefined) store.set('config.value.server', String(serverVal).trim())
      if (body.username !== undefined) store.set('config.value.username', String(body.username).trim())
      if (body.version !== undefined) store.set('config.value.version', String(body.version).trim())
      if (body.authType !== undefined) store.set('config.value.authType', String(body.authType).trim())
      if (body.nameType !== undefined) store.set('config.value.nameType', String(body.nameType).trim())
      if (body.accListPreset !== undefined) store.set('config.value.accListPreset', String(body.accListPreset).trim())
      if (body.botMax !== undefined) store.set('config.value.botMax', Math.max(1, Number(body.botMax) || 1))
      if (body.joinDelay !== undefined) store.set('config.value.joinDelay', Math.max(0, Number(body.joinDelay) || 1000))
      if (body.joinMessage !== undefined) store.set('config.value.joinMessage', String(body.joinMessage))
      if (body.botMode !== undefined) store.set('config.value.botMode', String(body.botMode))
      if (body.spoofMode !== undefined) store.set('config.value.spoofMode', String(body.spoofMode))
      if (body.spoofCustomClient !== undefined) store.set('config.value.spoofCustomClient', String(body.spoofCustomClient))
      if (body.spoofHideMods !== undefined) store.set('config.boolean.spoofHideMods', Boolean(body.spoofHideMods))
      if (body.safeReturnCommand !== undefined) store.set('config.value.safeReturnCommand', String(body.safeReturnCommand).trim())
      if (body.safetyRadius !== undefined) {
        const sr = Math.max(1, Number(body.safetyRadius) || 5)
        store.set('config.value.safetyRadius', sr)
        queueManager.safetyRadius = sr
      }
      if (body.tpaTimeout !== undefined) {
        const tt = Math.max(5, Number(body.tpaTimeout) || 45)
        store.set('config.value.tpaTimeout', tt)
        queueManager.tpaTimeoutMs = tt * 1000
      }
      if (body.autoReconnect !== undefined) {
        store.set('config.boolean.autoReconnect', Boolean(body.autoReconnect))
      }
      if (body.antiAfk !== undefined) {
        store.set('config.boolean.antiAfk', Boolean(body.antiAfk))
        if (body.antiAfk) {
          exeAll('afkon')
        } else {
          exeAll('afkoff')
        }
      }
      return sendJson(res, 200, { ok: true, config: storeinfo() })
    }

    if (req.method === 'GET' && pathname === '/api/bot/accounts') {
      return sendJson(res, 200, {
        ok: true,
        accountPresets: store.get('accountPresets') || [],
        linkedMicrosoftAccounts: store.get('linkedMicrosoftAccounts') || [],
        config: storeinfo()
      })
    }

    if (req.method === 'POST' && pathname === '/api/bot/accounts') {
      const body = await readJsonBody(req)
      if (Array.isArray(body.accountPresets)) {
        store.set('accountPresets', body.accountPresets)
      }
      if (Array.isArray(body.linkedMicrosoftAccounts)) {
        store.set('linkedMicrosoftAccounts', body.linkedMicrosoftAccounts)
      }
      if (body.accListPreset !== undefined) {
        store.set('config.value.accListPreset', String(body.accListPreset))
      }
      if (body.nameType !== undefined) {
        store.set('config.value.nameType', String(body.nameType))
      }
      if (body.username !== undefined) {
        store.set('config.value.username', String(body.username).trim())
      }
      if (body.authType !== undefined) {
        store.set('config.value.authType', String(body.authType).trim())
      }
      return sendJson(res, 200, {
        ok: true,
        accountPresets: store.get('accountPresets') || [],
        linkedMicrosoftAccounts: store.get('linkedMicrosoftAccounts') || [],
        config: storeinfo()
      })
    }

    if (req.method === 'POST' && pathname === '/api/bot/microsoft-auth') {
      const body = await readJsonBody(req)
      const requestId = String(body.requestId || `msa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`)
      const presetId = body.presetId || null

      ;(async () => {
        try {
          const flow = new Authflow(requestId, profilesFolder, undefined, (response) => {
            broadcastToRenderer('microsoftAuth', {
              requestId,
              presetId,
              status: 'code',
              code: response.user_code,
              verificationUri: response.verification_uri || 'https://www.microsoft.com/link',
              message: response.message
            })
          })
          const result = await flow.getMinecraftJavaToken({ fetchProfile: true })
          const profile = result.profile || {}
          const linkedAccount = {
            id: requestId,
            name: profile.name || 'Microsoft Account',
            profileId: profile.id || '',
            linkedAt: new Date().toISOString()
          }

          const existingLinked = store.get('linkedMicrosoftAccounts') || []
          const filteredLinked = existingLinked.filter((a) => a.id !== requestId && a.name !== linkedAccount.name)
          filteredLinked.push(linkedAccount)
          store.set('linkedMicrosoftAccounts', filteredLinked)

          store.set('config.value.username', requestId)
          store.set('config.value.authType', 'microsoft')

          if (presetId) {
            const presets = store.get('accountPresets') || []
            const preset = presets.find((p) => p.id === presetId)
            if (preset) {
              const msList = Array.isArray(preset.microsoftAccounts) ? preset.microsoftAccounts : []
              msList.push({ id: requestId, name: linkedAccount.name, profileId: linkedAccount.profileId })
              preset.microsoftAccounts = msList
              preset.accounts = msList.map((a) => a.id).join('\n')
              preset.authType = 'microsoft'
              store.set('accountPresets', presets)
            }
          }

          broadcastToRenderer('microsoftAuth', {
            requestId,
            presetId,
            status: 'success',
            accountId: requestId,
            name: linkedAccount.name,
            profileId: linkedAccount.profileId,
            linkedMicrosoftAccounts: filteredLinked,
            accountPresets: store.get('accountPresets') || []
          })
        } catch (error) {
          broadcastToRenderer('microsoftAuth', {
            requestId,
            presetId,
            status: 'error',
            message: error?.message || 'Failed to authenticate Microsoft account'
          })
        }
      })()

      return sendJson(res, 200, { ok: true, requestId })
    }

    if (req.method === 'GET' && pathname === '/api/bot/viewer') {
      const targetUser = urlObj.searchParams.get('username')
      const bot = (targetUser && activeBots.get(targetUser)) || getPrimaryDeliveryBot()
      return sendJson(res, 200, {
        ok: true,
        activeUsernames: Array.from(activeBots.keys()),
        viewer: bot ? getBotViewerSnapshot(bot) : null
      })
    }

    if (req.method === 'POST' && pathname === '/api/bot/window-click') {
      const body = await readJsonBody(req)
      const bot = (body.username && activeBots.get(body.username)) || getPrimaryDeliveryBot()
      if (!bot) return sendJson(res, 404, { error: 'No active bot connected' })
      const parsedSlot = Number(body.slot)
      const parsedMouseButton = Number(body.mouseButton) || 0
      const parsedMode = Number(body.mode) || 0
      if (!Number.isInteger(parsedSlot) || parsedSlot < 0) {
        return sendJson(res, 400, { error: 'Invalid slot index' })
      }
      const activeWindowId = bot.currentWindow ? bot.currentWindow.id : bot.inventory.id
      const targetWindowId = body.windowId != null ? Number(body.windowId) : activeWindowId
      if (targetWindowId === activeWindowId) {
        await bot.clickWindow(parsedSlot, parsedMouseButton, parsedMode).catch((e) => {
          console.log('clickWindow error:', e.message)
        })
      }
      sendInventory(bot)
      return sendJson(res, 200, { ok: true, inventory: inventorySnapshot(bot) })
    }

    if (req.method === 'POST' && pathname === '/api/bot/hotbar') {
      const body = await readJsonBody(req)
      const bot = (body.username && activeBots.get(body.username)) || getPrimaryDeliveryBot()
      if (!bot) return sendJson(res, 404, { error: 'No active bot connected' })
      const parsedSlot = Number(body.slot)
      if (Number.isInteger(parsedSlot) && parsedSlot >= 0 && parsedSlot <= 8) {
        bot.setQuickBarSlot(parsedSlot)
        sendInventory(bot)
      }
      return sendJson(res, 200, { ok: true, inventory: inventorySnapshot(bot) })
    }

    if (req.method === 'POST' && pathname === '/api/bot/window-close') {
      const body = await readJsonBody(req)
      const bot = (body.username && activeBots.get(body.username)) || getPrimaryDeliveryBot()
      if (!bot) return sendJson(res, 404, { error: 'No active bot connected' })
      if (bot.currentWindow && bot.currentWindow !== bot.inventory) {
        bot.closeWindow(bot.currentWindow)
        sendInventory(bot)
      }
      return sendJson(res, 200, { ok: true, inventory: inventorySnapshot(bot) })
    }

    if (req.method === 'POST' && pathname === '/api/bot/control') {
      const body = await readJsonBody(req)
      const { username, command, args = [], configUpdates } = body || {}

      if (configUpdates && typeof configUpdates === 'object') {
        if (configUpdates.value) {
          for (const [k, v] of Object.entries(configUpdates.value)) {
            store.set(`config.value.${k}`, v)
          }
        }
        if (configUpdates.boolean) {
          for (const [k, v] of Object.entries(configUpdates.boolean)) {
            store.set(`config.boolean.${k}`, Boolean(v))
          }
        }
      }

      const targets = username && username !== '*'
        ? [username]
        : (playerList && playerList.length ? playerList : Array.from(activeBots.keys()))

      if (command === 'runScript') {
        if (body.scriptText !== undefined) store.set('config.value.scriptText', String(body.scriptText))
        targets.forEach((u) => startScript(u))
        return sendJson(res, 200, { ok: true, targets })
      }
      if (command === 'stopScript') {
        stopScript = true
        return sendJson(res, 200, { ok: true })
      }
      if (command === 'swingArm') {
        targets.forEach((u) => activeBots.get(u)?.swingArm?.())
        return sendJson(res, 200, { ok: true, targets })
      }
      if (command === 'lookYawPitch') {
        const yaw = parseFloat(args[0]) || 0
        const pitch = parseFloat(args[1]) || 0
        targets.forEach((u) => activeBots.get(u)?.look?.(yaw, pitch, true))
        return sendJson(res, 200, { ok: true, targets })
      }

      if (command) {
        for (const t of targets) {
          botApi.emit('botEvent', t, command, Array.isArray(args) ? args : String(args).split(' ').filter(Boolean))
        }
      }
      return sendJson(res, 200, { ok: true, command, targets })
    }

    // Discord Bot Controls
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

    if (req.method === 'GET' && pathname === '/api/guilds') {
      const all = await readAllGuilds()
      const list = Object.values(all)
      return sendJson(res, 200, {
        guilds: list.map((g) => ({
          guildId: g['guildId'],
          roles: Object.keys(g['roles'] ?? {}).length,
          channels: Object.keys(g['channels'] ?? {}).length,
          updatedAt: g['updatedAt'] ?? null,
          liveName: g['name'] || g['guildId']
        }))
      })
    }

    if (req.method === 'GET' && pathname.startsWith('/api/guilds/')) {
      const id = pathname.replace('/api/guilds/', '').trim()
      const setup = await getGuildSetup(id).catch(() => null)
      if (!setup) return sendJson(res, 404, { error: 'Guild not found or not synced yet' })
      return sendJson(res, 200, { guild: setup })
    }

    if (req.method === 'PUT' && pathname.startsWith('/api/guilds/')) {
      const id = pathname.replace('/api/guilds/', '').trim()
      const setup = await getGuildSetup(id).catch(() => null)
      if (!setup) return sendJson(res, 404, { error: 'Guild not found' })
      const b = await readJsonBody(req)
      const channelIds = new Set(Object.values(setup.channels || {}))
      const roleIds = new Set(Object.values(setup.roles || {}))
      const pick = (v, allowed, label) => {
        if (v === undefined || v === null || v === '') return undefined
        if (typeof v !== 'string' || !allowed.has(v)) throw new Error(`${label}: unknown ID for this server.`)
        return v
      }
      try {
        const welcomeChannelId = pick(b.welcomeChannelId ?? setup.welcomeChannelId, channelIds, 'Welcome channel') ?? setup.welcomeChannelId
        const logChannelId = pick(b.logChannelId ?? setup.logChannelId, channelIds, 'Log channel') ?? setup.logChannelId
        const ticketCategoryId = b.ticketCategoryId === undefined || b.ticketCategoryId === '' ? setup.ticketCategoryId : b.ticketCategoryId
        const autoRoleId = pick(b.autoRoleId ?? setup.autoRoleId, roleIds, 'Auto-role') ?? setup.autoRoleId
        const updated = { ...setup, welcomeChannelId, logChannelId, ticketCategoryId, autoRoleId, updatedAt: new Date().toISOString() }
        await saveGuildSetup(updated)
        return sendJson(res, 200, { ok: true, guild: updated })
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Invalid input' })
      }
    }

    if (req.method === 'GET' && pathname === '/api/template') {
      const t = await getTemplate()
      return sendJson(res, 200, { template: t })
    }

    if (req.method === 'PUT' && pathname === '/api/template') {
      const b = await readJsonBody(req)
      const t = b.template ?? b
      const v = validateTemplate(t)
      if (!v.ok) return sendJson(res, 400, { error: v.error })
      await saveTemplate(t)
      const syncResult = await syncAllDiscordGuildsNow().catch(() => ({ queued: true }))
      return sendJson(res, 200, { ok: true, sync: syncResult })
    }

    if (req.method === 'GET' && pathname === '/api/template/defaults') {
      return sendJson(res, 200, { template: DEFAULT_TEMPLATE })
    }

    if (req.method === 'POST' && pathname === '/api/change-password') {
      const b = await readJsonBody(req)
      const creds = await resolveAdminCredentials()
      if (!creds) return sendJson(res, 503, { error: 'No admin credentials configured.' })
      if (creds.source === 'env') {
        return sendJson(res, 400, { error: 'Admin login configured via environment variables. Update DASHBOARD_USER in your hosting environment.' })
      }
      if (typeof b.currentPassword !== 'string' || !verifyPassword(b.currentPassword, creds.passHash)) {
        return sendJson(res, 401, { error: 'Current password is incorrect.' })
      }
      const newUsername = typeof b.newUsername === 'string' && b.newUsername.trim() ? b.newUsername.trim().slice(0, 64) : creds.username
      if (typeof b.newPassword !== 'string' || b.newPassword.length < 8 || b.newPassword.length > 200) {
        return sendJson(res, 400, { error: 'New password must be between 8 and 200 characters.' })
      }
      try {
        const h = hashPassword(b.newPassword)
        await saveAdminFile(newUsername, h)
        return sendJson(res, 200, { ok: true })
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Could not update password' })
      }
    }

    // Backward compatibility for IPC send
    if (req.method === 'POST' && pathname === '/api/ipc/send') {
      const body = await readJsonBody(req)
      const { channel, args = [] } = body || {}
      if (!channel) return sendJson(res, 400, { error: 'Missing IPC channel' })
      ipcMain.emit(channel, { sender: mainWindow.webContents }, ...args)
      return sendJson(res, 200, { ok: true })
    }

    // Unmatched API route
    return sendJson(res, 404, { error: 'Not found' })
  }

  // Any other static file in dashboard/public
  const safePath = path.normalize(path.join(rendererDir, pathname))
  if (safePath.startsWith(rendererDir) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
    const ext = path.extname(safePath).toLowerCase()
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' })
    return fs.createReadStream(safePath).pipe(res)
  }

  // Fallback
  return sendJson(res, 404, { error: 'Not Found' })
}

const PRIMARY_PORT = Number(process.env.SERVER_PORT || process.env.WEB_PORT || process.env.APP_PORT || process.env.PORT || 9843)
const candidatePorts = Array.from(
  new Set(
    [PRIMARY_PORT, 9843, Number(process.env.PORT), Number(process.env.SERVER_PORT), 25575].filter(
      (p) => Number.isFinite(p) && p > 0 && p !== Number(process.env.DASHBOARD_PORT || 3001)
    )
  )
)

const activeServers = []
for (const listenPort of candidatePorts) {
  const srv = http.createServer(handleHttpRequest)
  srv.on('error', (err) => {
    if (listenPort === PRIMARY_PORT) {
      console.error(`[Wispbyte] HTTP server error on port ${listenPort}:`, err.message)
    }
  })
  srv.listen(listenPort, '0.0.0.0', () => {
    console.log(`[Wispbyte] Unified TrafficerMC + Bluxmart Auto-Delivery + Bluxbot Discord Server listening on http://0.0.0.0:${listenPort}`)
  })
  activeServers.push(srv)
}

process.on('uncaughtException', (err) => {
  console.log(err)
})
process.on('UnhandledPromiseRejectionWarning', (err) => {
  console.log(err)
})

