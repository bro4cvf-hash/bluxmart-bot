import fs from 'fs'
import path from 'path'
import { checkAreaSafety } from './safety.js'
import {
  withdrawFromEnderChest,
  depositBackToEnderChest,
  matchesCatalogCategory,
  isChestLidBlocked
} from './enderchest.js'

const DEFAULT_QUEUE_FILE = path.resolve('./delivery-queue.json')
const FALLBACK_QUEUE_FILE = path.resolve('./orders-queue.json')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function safeChat(bot, msg) {
  if (!bot || typeof bot.chat !== 'function') return
  const clean = String(msg ?? '')
    .replace(/[\r\n\0]/g, ' ')
    .trim()
    .slice(0, 256)
  if (clean) {
    bot.chat(clean)
  }
}

/**
 * Checks if a player is online using tab completion on '/tpa <prefix>'.
 * Prefix consists of all letters of the username except the last one.
 * Verifies that the tab completion suggestions contain the exact case-insensitive username.
 */
export async function isPlayerOnline(bot, username, timeoutMs = 3500) {
  if (!bot || !username) return false
  const target = String(username || '').trim().toLowerCase()
  if (!target) return false

  // Step A: Instant check via bot.players
  const directPlayers = new Set(Object.keys(bot?.players || {}).map((p) => p.toLowerCase()))
  if (directPlayers.has(target)) return true

  // Step B: Tab completion check
  if (typeof bot.tabComplete === 'function') {
    try {
      const prefix = target.length > 1 ? target.slice(0, -1) : target
      const tabQuery = `/tpa ${prefix}`
      const matches = await bot.tabComplete(tabQuery, false, false, timeoutMs)
      if (Array.isArray(matches) && matches.length > 0) {
        const found = matches.some((item) => {
          const raw = typeof item === 'string' ? item : (item.match || item.name || '')
          const parts = String(raw).trim().split(/\s+/)
          const candidate = parts[parts.length - 1].replace(/^[/]/, '').toLowerCase()
          return candidate === target
        })
        if (found) return true
      }
    } catch (err) {
      // Tab completion timed out or rejected
    }
  }

  // Step C: Final fallback check via bot.players in case tab list updated
  return new Set(Object.keys(bot?.players || {}).map((p) => p.toLowerCase())).has(target)
}

export class DeliveryQueueManager {
  constructor(botGetter, config = {}) {
    this.getBot = botGetter
    this.queueFilePath = config.queueFilePath || process.env.QUEUE_FILE_PATH || DEFAULT_QUEUE_FILE
    this.backupFilePath = `${this.queueFilePath}.bak`
    this.tempFilePath = `${this.queueFilePath}.tmp`
    this.tombstoneFilePath = `${this.queueFilePath}.tombstones.json`
    this.safeReturnCommand = config.safeReturnCommand || process.env.SAFE_RETURN_COMMAND || '/home 1'
    this.safetyRadius = Number(config.safetyRadius || process.env.SAFETY_RADIUS || 5)
    this.tpaTimeoutMs = Number(config.tpaTimeoutMs || process.env.TPA_TIMEOUT_MS || 60000)
    this.maxRetries = Number(config.maxRetries || process.env.MAX_DELIVERY_RETRIES || 5)
    this.onLog = config.onLog || ((msg) => console.log(msg))
    this.onOrderUpdate = config.onOrderUpdate || config.onStatusChange || (() => {})
    this.onStatusChange = config.onStatusChange || config.onOrderUpdate || (() => {})
    this.processing = false
    this.completedOrderIds = new Set()
    this.loadTombstones()
    this.queue = this.loadQueue()
  }

  log(msg, level = 'info') {
    this.onLog(msg, level)
  }

  loadTombstones() {
    try {
      if (fs.existsSync(this.tombstoneFilePath)) {
        const raw = fs.readFileSync(this.tombstoneFilePath, 'utf8')
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          for (const id of parsed) {
            if (id) this.completedOrderIds.add(String(id))
          }
        }
      }
    } catch (err) {
      console.warn(`[QUEUE] Failed to load tombstones (${this.tombstoneFilePath}):`, err.message)
    }
  }

  saveTombstones() {
    try {
      const data = JSON.stringify(Array.from(this.completedOrderIds), null, 2)
      fs.writeFileSync(this.tombstoneFilePath, data, 'utf8')
    } catch (err) {
      console.warn(`[QUEUE] Failed to save tombstones (${this.tombstoneFilePath}):`, err.message)
    }
  }

  markOrderTombstoned(orderId) {
    if (!orderId) return
    const rawStr = String(orderId).trim()
    const cleanId = rawStr.replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 64)
    if (rawStr) this.completedOrderIds.add(rawStr)
    if (cleanId) this.completedOrderIds.add(cleanId)
    this.saveTombstones()
  }

  async notifyUpdate(order, extra = {}) {
    if (extra && extra.chatMessage) {
      order.lastChatMessage = extra.chatMessage
    }
    if (typeof this.onOrderUpdate === 'function') {
      try {
        await this.onOrderUpdate(order, extra)
      } catch (err) {
        this.log(`[QUEUE] onOrderUpdate error: ${err.message}`, 'error')
      }
    }
    if (typeof this.onStatusChange === 'function' && this.onStatusChange !== this.onOrderUpdate) {
      try {
        await this.onStatusChange(order, extra)
      } catch (err) {
        this.log(`[QUEUE] onStatusChange error: ${err.message}`, 'error')
      }
    }
  }

  /**
   * Resilient Queue Loader:
   * 1. Attempts to load and parse primary queue file.
   * 2. If primary file is corrupted, empty, or unparseable, automatically recovers from .bak backup.
   * 3. Falls back to fallback queue file or empty array.
   * 4. Resets any 'delivering' orders to 'waiting_for_player' and populates completedOrderIds.
   */
  loadQueue() {
    const tryLoad = (filePath) => {
      try {
        if (fs.existsSync(filePath)) {
          const raw = fs.readFileSync(filePath, 'utf8')
          if (raw && raw.trim().length > 0) {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) return parsed
          }
        }
      } catch (err) {
        console.error(`[QUEUE] Failed to load queue file (${filePath}):`, err.message)
      }
      return null
    }

    let loaded = tryLoad(this.queueFilePath)
    if (!loaded) {
      const backup = tryLoad(this.backupFilePath)
      if (backup) {
        this.log(`[QUEUE] ⚠️ Primary queue file corrupted/missing. Successfully restored queue from backup (${this.backupFilePath})!`, 'warn')
        loaded = backup
      }
    }
    if (!loaded) {
      loaded = tryLoad(FALLBACK_QUEUE_FILE) || []
    }

    let needsSave = false
    for (const item of loaded) {
      if (!item || typeof item !== 'object') continue
      const itemId = String(item.orderId || item.id || '').trim()
      if (item.status === 'delivering') {
        item.status = 'waiting_for_player'
        item.nextAttemptAt = 0
        item.lastError = 'Recovered from bot restart during delivery'
        needsSave = true
      }
      if (item.status === 'failed' && item.lastError && String(item.lastError).includes('lid obstructed')) {
        item.status = 'pending'
        item.attempts = 0
        item.lastError = null
        item.nextAttemptAt = 0
        needsSave = true
      }
      if (item.status === 'completed' || item.status === 'cancelled') {
        if (itemId) {
          this.completedOrderIds.add(itemId)
          this.completedOrderIds.add(itemId.replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 64))
        }
      }
    }

    if (needsSave) {
      this.queue = loaded
      this.saveQueue()
    }
    if (this.completedOrderIds.size > 0) {
      this.saveTombstones()
    }

    return loaded
  }

  /**
   * Atomic Queue Persistence:
   * Writes to a temp file first, then atomically renames to prevent 0-byte wipeouts upon crash.
   * Also maintains a .bak copy for self-healing disaster recovery.
   */
  saveQueue() {
    try {
      const data = JSON.stringify(this.queue, null, 2)
      fs.writeFileSync(this.tempFilePath, data, 'utf8')
      fs.renameSync(this.tempFilePath, this.queueFilePath)
      try {
        fs.writeFileSync(this.backupFilePath, data, 'utf8')
      } catch {}
    } catch (err) {
      console.error(`[QUEUE] Failed to atomically write queue file (${this.queueFilePath}):`, err.message)
    }
  }

  enqueue(order) {
    return this.enqueueOrder(order)
  }

  enqueueOrder(order) {
    const rawId =
      String(order.orderId || order.id || `ord_${Date.now()}`)
        .replace(/[^a-zA-Z0-9_\-]/g, '')
        .slice(0, 64) || `ord_${Date.now()}`

    if (this.completedOrderIds.has(rawId)) {
      const existingTombstone = this.queue.find((o) => (o.orderId === rawId || o.id === rawId))
      return {
        status: 'tombstoned',
        order: existingTombstone || { orderId: rawId, id: rawId, status: 'completed' }
      }
    }

    const existing = this.queue.find((o) => (o.orderId === rawId || o.id === rawId))
    if (existing) {
      return { status: 'already_queued', order: existing }
    }

    const rawUsername = String(order.minecraftUsername || order.recipient || '').trim()
    if (!/^\.?[a-zA-Z0-9_]{3,16}$/.test(rawUsername)) {
      throw new Error(`Invalid Minecraft username "${rawUsername}". Must be 3-16 alphanumeric/underscore characters with no spaces.`)
    }
    const moneyAmount = Math.max(0, Math.min(100_000_000_000, Math.floor(Number(order.moneyAmount ?? order.money) || 0)))
    const spawners = Math.max(0, Math.floor(Number(order.spawners) || 0))
    const elytras = Math.max(0, Math.floor(Number(order.elytras) || 0))
    const otherItemsCount = Math.max(0, Math.floor(Number(order.otherItemsCount) || 0))
    const hasNonMoneyItems =
      Boolean(order.hasNonMoneyItems) || spawners > 0 || elytras > 0 || otherItemsCount > 0

    const moneyDelivered = Boolean(order.moneyDelivered) || moneyAmount === 0
    const itemsDelivered =
      Boolean(order.itemsDelivered) || (spawners === 0 && elytras === 0 && !hasNonMoneyItems)

    const entry = {
      orderId: rawId,
      id: rawId,
      minecraftUsername: rawUsername,
      recipient: rawUsername,
      moneyAmount,
      money: moneyAmount,
      spawners,
      elytras,
      initialSpawners: spawners,
      initialElytras: elytras,
      otherItemsCount,
      hasNonMoneyItems,
      itemsSummary: order.itemsSummary || '',
      moneyDelivered,
      itemsDelivered,
      attempts: 0,
      status: moneyDelivered && itemsDelivered ? 'completed' : 'pending',
      lastError: null,
      nextAttemptAt: 0,
      createdAt: order.createdAt || Date.now(),
      updatedAt: Date.now()
    }

    if (entry.status === 'completed') {
      this.markOrderTombstoned(rawId)
    }

    this.queue.push(entry)
    this.saveQueue()
    this.log(
      `[QUEUE] Added Order #${entry.orderId} for ${entry.minecraftUsername} (Money: $${entry.moneyAmount.toLocaleString()} [Offline OK], Spawners: ${entry.spawners}, Elytras: ${entry.elytras}${entry.hasNonMoneyItems ? ' [Must Be In-Game]' : ''})`
    )
    this.processNext()
    return { status: 'queued', order: entry }
  }

  /**
   * Retries ALL non-completed orders for a player when they join or whisper 'claim'.
   * Fixes EC-07 (Multiple Orders for Same Player).
   */
  retryPendingForPlayer(username) {
    if (!username) return false
    const lower = username.toLowerCase().trim()
    const targets = this.queue.filter(
      (o) =>
        (((o.minecraftUsername && o.minecraftUsername.toLowerCase() === lower) ||
          (o.recipient && o.recipient.toLowerCase() === lower))) &&
        o.status !== 'completed' &&
        o.status !== 'waiting_for_staff'
    )
    if (targets.length > 0) {
      for (const target of targets) {
        target.status = 'pending'
        target.attempts = 0
        target.lastError = null
        target.nextAttemptAt = 0
        target.updatedAt = Date.now()
        this.log(`[QUEUE] Player ${username} requested claim/joined. Re-queued Order #${target.orderId || target.id}`)
      }
      this.saveQueue()
      this.processNext()
      return true
    }
    return false
  }

  getQueueStatus() {
    const bot = this.getBot()
    const onlinePlayers = new Set(
      Object.keys(bot?.players || {}).map((p) => p.toLowerCase())
    )
    return {
      processing: this.processing,
      totalCount: this.queue.length,
      pendingCount: this.queue.filter((o) => o.status === 'pending' || o.status === 'queued').length,
      waitingCount: this.queue.filter((o) => o.status === 'waiting_for_player' || o.status === 'waiting_for_staff').length,
      completedCount: this.queue.filter((o) => o.status === 'completed').length,
      failedCount: this.queue.filter((o) => o.status === 'failed').length,
      orders: this.queue.map((o) => ({
        ...o,
        isPlayerOnline: onlinePlayers.has((o.minecraftUsername || o.recipient || '').toLowerCase())
      }))
    }
  }

  /**
   * Waits for the bot to actually arrive back at base coordinates after sending safe return command (/home 1).
   * Fixes EC-06 (Teleport Warmup Race on Abort).
   */
  async returnToBaseSafely(bot, basePos, timeoutMs = 6000) {
    if (basePos && bot.entity && bot.entity.position.distanceTo(basePos) <= 4) {
      if (bot.currentWindow) {
        try { bot.closeWindow(bot.currentWindow) } catch {}
      }
      return true
    }

    let cmd = String(this.safeReturnCommand || '/home 1').trim()
    if (cmd === '/home') cmd = '/home 1'
    safeChat(bot, cmd)
    await delay(600)

    // On DonutSMP, if sending return command opened a window (e.g. "Homes" GUI):
    if (bot.currentWindow) {
      const win = bot.currentWindow
      const title = String(win.title || '').toLowerCase()
      if (title.includes('home')) {
        const homeSlot = win.slots ? win.slots.findIndex((s, idx) => s && s.name && idx < (win.inventoryStart || 27)) : -1
        if (homeSlot !== -1 && typeof bot.clickWindow === 'function') {
          try {
            await bot.clickWindow(homeSlot, 0, 0)
            await delay(1200)
          } catch {}
        }
      }
      if (bot.currentWindow) {
        try { bot.closeWindow(bot.currentWindow) } catch {}
      }
    }

    if (!basePos || !bot.entity) {
      await delay(2000)
      return true
    }

    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      await delay(400)
      if (!bot.entity) break
      if (bot.entity.position.distanceTo(basePos) <= 8) {
        return true
      }
    }
    return false
  }

  /**
   * Core scheduling loop with Head-of-Line Starvation Prevention:
   * 1. Money orders (offline capable) always run first.
   * 2. Physical item orders: verifies online status in bot.players and backoff timestamp.
   *    Offline players are deferred to waiting_for_player without consuming TPA wait cycles.
   * 3. Zombie state guard: try/catch/finally guarantees status reset on any exception.
   */
  async processNext() {
    if (this.processing) {
      this.pendingRerun = true
      return
    }
    const bot = this.getBot()
    if (!bot || !bot.entity) return

    this.processing = true
    try {
      while (true) {
        this.pendingRerun = false
        const now = Date.now()
        let nextOrder = null

        // Priority 1: Any order that still needs Money sent (works offline & online)
        nextOrder = this.queue.find(
          (o) =>
            o.status !== 'completed' &&
            o.status !== 'failed' &&
            !o.moneyDelivered &&
            (o.moneyAmount > 0 || o.money > 0) &&
            (o.nextAttemptAt || 0) <= now
        )

        // Priority 2: Physical items for ONLINE buyers whose backoff timer has elapsed
        if (!nextOrder) {
          const eligiblePhysicalOrders = this.queue.filter((o) => {
            if (o.status === 'completed' || o.status === 'failed' || o.status === 'waiting_for_staff') return false
            if (o.itemsDelivered || !o.hasNonMoneyItems) return false
            if (o.attempts >= this.maxRetries) return false
            if ((o.nextAttemptAt || 0) > now) return false
            return true
          })

          for (const candidate of eligiblePhysicalOrders) {
            // Allow unsupported custom item orders (spawners === 0 && elytras === 0 && otherItemsCount > 0) to transition immediately to waiting_for_staff
            if (candidate.otherItemsCount > 0 && candidate.spawners === 0 && candidate.elytras === 0) {
              nextOrder = candidate
              break
            }

            const user = String(candidate.minecraftUsername || candidate.recipient || '').trim()
            const isOnline = await isPlayerOnline(bot, user)
            if (isOnline) {
              nextOrder = candidate
              break
            } else {
              // Defer offline player with backoff without blocking the queue
              candidate.status = 'waiting_for_player'
              candidate.lastError = `Buyer ${user} is offline (tab suggestion not found)`
              candidate.nextAttemptAt = now + 15000
              candidate.updatedAt = now
              this.saveQueue()
              this.notifyUpdate(candidate, {
                chatMessage: `⏳ Order #${candidate.orderId} for ${candidate.minecraftUsername} is waiting: buyer is currently offline on donutsmp.net.`
              })
            }
          }
        }

        if (nextOrder) {
          try {
            await this.executeOrder(bot, nextOrder)
          } catch (err) {
            this.log(`[DELIVERY] Error processing order ${nextOrder.orderId}: ${err.message}`, 'error')
            nextOrder.lastError = err.message
            nextOrder.updatedAt = Date.now()

            const isInsufficientStock = String(err.message || '').includes('Insufficient')
            if (isInsufficientStock) {
              nextOrder.attempts = Math.max(0, (nextOrder.attempts || 1) - 1)
              nextOrder.status = 'waiting_for_player'
              nextOrder.nextAttemptAt = Date.now() + 30000
              nextOrder.lastChatMessage = `⏳ Waiting for Ender Chest restock to fulfill Order #${nextOrder.orderId}. Retrying automatically...`
              this.log(
                `[DELIVERY] Ender Chest stock-out for Order #${nextOrder.orderId}; attempt not counted toward maxRetries. Waiting 30s for restock.`,
                'warn'
              )
            } else {
              // Guaranteed Zombie State Cleanup (EC-01 & EC-10)
              if (nextOrder.status === 'delivering' || nextOrder.status === 'pending') {
                if (nextOrder.attempts >= this.maxRetries) {
                  nextOrder.status = 'failed'
                  nextOrder.lastChatMessage = `⚠️ Auto-delivery failed after ${this.maxRetries} attempts (${err.message}). Staff have been alerted to complete your delivery manually.`
                  this.log(`[DELIVERY] Order #${nextOrder.orderId} reached max retries (${this.maxRetries}). Marked FAILED (Dead-Letter).`, 'error')
                } else {
                  nextOrder.status = 'waiting_for_player'
                }
              }

              // Exponential backoff: 5s, 10s, 20s, 40s... up to 180s
              const backoffSec = Math.min(180, Math.max(5, Math.pow(2, nextOrder.attempts) * 5))
              nextOrder.nextAttemptAt = Date.now() + backoffSec * 1000
            }

            this.saveQueue()
            await this.notifyUpdate(nextOrder)
          }
        } else {
          // If no order was executable and no concurrent rerun requested, finish loop
          if (!this.pendingRerun) {
            break
          }
        }
      }
    } finally {
      this.processing = false
      if (this.processTimer) clearTimeout(this.processTimer)
      this.processTimer = setTimeout(() => this.processNext(), 2000)
    }
  }

  async executeOrder(botOrOrder, maybeOrder) {
    const bot = maybeOrder !== undefined ? botOrOrder : this.getBot()
    const order = maybeOrder !== undefined ? maybeOrder : botOrOrder
    const username = String(order.minecraftUsername || order.recipient || '').trim()
    if (!/^\.?[a-zA-Z0-9_]{3,16}$/.test(username)) {
      order.status = 'failed'
      order.lastError = 'Blocked invalid Minecraft username (command injection guard)'
      this.saveQueue()
      throw new Error(order.lastError)
    }
    this.log(
      `[DELIVERY] Processing Order #${order.orderId} for ${username} (Money: $${order.moneyAmount.toLocaleString()}, Spawners: ${order.spawners}, Elytras: ${order.elytras})`
    )

    // 1. Deliver Money via /pay <username> <amount> (Offline Capable)
    if (!order.moneyDelivered && order.moneyAmount > 0) {
      this.log(
        `[OFFLINE-PAY] Sending $${order.moneyAmount.toLocaleString()} to ${username} via /pay...`
      )
      let payFailureMsg = null
      const payErrorKeywords = [
        'not found',
        'offline',
        'insufficient',
        'not enough',
        'cannot pay',
        'disabled',
        'error'
      ]
      const onPayMessage = (msg) => {
        const lowerMsg = String(msg || '').toLowerCase()
        if (payErrorKeywords.some((kw) => lowerMsg.includes(kw))) {
          payFailureMsg = String(msg).trim()
        }
      }
      if (typeof bot.on === 'function') {
        bot.on('messagestr', onPayMessage)
      }
      try {
        safeChat(bot, `/pay ${username} ${order.moneyAmount}`)
        await delay(1800)
      } finally {
        if (typeof bot.removeListener === 'function') {
          bot.removeListener('messagestr', onPayMessage)
        } else if (typeof bot.off === 'function') {
          bot.off('messagestr', onPayMessage)
        }
      }

      if (payFailureMsg) {
        order.attempts = (order.attempts || 0) + 1
        throw new Error(`/pay failed for ${username}: ${payFailureMsg}`)
      }

      safeChat(
        bot,
        `/msg ${username} [Bluxmart] Paid $${order.moneyAmount.toLocaleString()} for Order #${order.orderId}!`
      )
      order.moneyDelivered = true
      if (!order.hasNonMoneyItems || (order.spawners === 0 && order.elytras === 0 && order.otherItemsCount === 0)) {
        order.itemsDelivered = true
        order.status = 'completed'
        this.markOrderTombstoned(order.orderId)
      }
      order.updatedAt = Date.now()
      this.saveQueue()

      await this.notifyUpdate(order, {
        chatMessage: order.itemsDelivered
          ? `💸 Paid $${order.moneyAmount.toLocaleString()} to ${username} via /pay! Your money-only order #${order.orderId} is now complete.`
          : `💸 Paid $${order.moneyAmount.toLocaleString()} to ${username} via /pay! Now waiting for ${username} to be in-game on donutsmp.net for physical items.`
      })
    }

    // 2. Deliver Physical Items (Spawners / Elytras) — PLAYER MUST BE IN-GAME
    if (!order.itemsDelivered && (order.spawners > 0 || order.elytras > 0 || order.hasNonMoneyItems)) {
      // Prevent false-positive delivery of unsupported custom items (otherItemsCount > 0 when spawners === 0 && elytras === 0)
      if (order.otherItemsCount > 0 && order.spawners === 0 && order.elytras === 0) {
        order.status = 'waiting_for_staff'
        order.lastError = 'Custom catalog items require manual staff handoff'
        order.lastChatMessage =
          '📦 Your money (if any) was processed! Your custom catalog items require manual staff handoff in live chat.'
        order.updatedAt = Date.now()
        this.saveQueue()
        this.log(
          `[DELIVERY] Order #${order.orderId} has ${order.otherItemsCount} custom item(s) and 0 Spawners/Elytras; routed to manual staff handoff.`,
          'warn'
        )
        await this.notifyUpdate(order, {
          chatMessage: order.lastChatMessage
        })
        return
      }

      // Pre-flight Online Check: Confirm buyer is online via tab complete right before physical handling
      this.log(`[DELIVERY] [${order.orderId}] Step 1: Checking buyer ${username} online status...`)
      const isOnline = await isPlayerOnline(bot, username)
      if (!isOnline) {
        order.status = 'waiting_for_player'
        order.lastError = `Buyer ${username} is offline on donutsmp.net`
        order.nextAttemptAt = Date.now() + 15000
        order.updatedAt = Date.now()
        this.saveQueue()
        this.log(`[DELIVERY] [${order.orderId}] Buyer ${username} is offline on server. Deferring to waiting_for_player.`)
        return
      }

      order.status = 'delivering'
      order.attempts += 1
      order.updatedAt = Date.now()
      this.saveQueue()
      await this.notifyUpdate(order)

      this.log(`[DELIVERY] [${order.orderId}] Step 2: Preparing base & Ender Chest...`)

      // Step 2a: Ensure any open window is closed and return to base only if not near Ender Chest
      if (bot.currentWindow) {
        try { bot.closeWindow(bot.currentWindow) } catch {}
        await delay(200)
      }
      let nearbyEC = bot.findBlock ? bot.findBlock({
        matching: (block) => block && block.name === 'ender_chest',
        maxDistance: 4.5
      }) : null
      if (!nearbyEC) {
        await this.returnToBaseSafely(bot, null, 4000)
        await delay(300)
        nearbyEC = bot.findBlock ? bot.findBlock({
          matching: (block) => block && block.name === 'ender_chest',
          maxDistance: 4.5
        }) : null
      }
      const startBasePos = bot.entity?.position ? bot.entity.position.clone() : null

      // Step 2b: Ensure bot inventory starts clean (deposit any leftover spawners/elytras into Ender Chest)
      this.log(`[DELIVERY] [${order.orderId}] Step 2b: Clearing stray inventory into Ender Chest...`)
      if (order.spawners > 0 || order.elytras > 0) {
        await depositBackToEnderChest(bot)
      }

      // Step 2c: Withdraw exact items ordered from Ender Chest
      if (order.spawners > 0 || order.elytras > 0) {
        this.log(
          `[DELIVERY] [${order.orderId}] Step 2c: Withdrawing ${order.spawners || 0}x Spawner, ${order.elytras || 0}x Elytra from Ender Chest...`
        )
        try {
          await withdrawFromEnderChest(bot, {
            spawners: order.spawners,
            elytras: order.elytras
          })
        } catch (err) {
          order.lastError = err.message
          this.log(`[DELIVERY] [${order.orderId}] Ender Chest error: ${err.message}`)
          throw err
        }
      }
      // Step 2d: Send /tpa <username> and listen for immediate offline feedback
      let offlineChatDetected = null
      const offlineKeywords = [
        'not online',
        'is not online',
        'player not found',
        'user not found',
        'user is not online',
        'player is offline',
        'could not find player',
        'no player found'
      ]

      const onTpaChatMessage = (msg) => {
        const lower = String(msg || '').toLowerCase()
        if (offlineKeywords.some((kw) => lower.includes(kw))) {
          offlineChatDetected = String(msg).trim()
        }
      }

      if (typeof bot.on === 'function') {
        bot.on('messagestr', onTpaChatMessage)
      }

      let tpResult
      try {
        this.log(`[DELIVERY] [${order.orderId}] Step 2d: Sending /tpa ${username}...`)
        safeChat(bot, `/tpa ${username}`)
        await delay(600)
        if (!offlineChatDetected) {
          safeChat(
            bot,
            `/msg ${username} [Bluxmart] Order #${order.orderId} ready! Accept /tpa in-game in a SAFE spot (no hazards or PvP).`
          )
        }

        // Wait for teleport completion
        tpResult = await this.waitForTeleport(
          bot,
          username,
          startBasePos,
          this.tpaTimeoutMs,
          () => offlineChatDetected
        )
      } finally {
        if (typeof bot.removeListener === 'function') {
          bot.removeListener('messagestr', onTpaChatMessage)
        } else if (typeof bot.off === 'function') {
          bot.off('messagestr', onTpaChatMessage)
        }
      }
      if (!tpResult || !tpResult.success) {
        const isOfflineChat = tpResult?.reason === 'offline_chat'
        if (isOfflineChat) {
          this.log(
            `[DELIVERY] [${order.orderId}] Server chat confirmed buyer offline: "${offlineChatDetected}". Canceling TPA.`
          )
        }
        const errorReason = isOfflineChat
          ? `Buyer is offline (chat: "${tpResult.message}")`
          : (tpResult?.reason === 'timeout' ? 'Waiting for buyer to accept /tpa' : '/tpa failed')

        this.log(
          `[DELIVERY] /tpa to ${username} aborted (${errorReason}). Safely returning items to Ender Chest.`,
          'warn'
        )
        if (!isOfflineChat) {
          safeChat(
            bot,
            `/msg ${username} [Bluxmart] /tpa expired for Order #${order.orderId}. Whisper "claim" in-game to retry!`
          )
        }
        if (order.spawners > 0 || order.elytras > 0) {
          await this.returnToBaseSafely(bot, startBasePos, 8000)
          await depositBackToEnderChest(bot)
        }
        const reachedMax = order.attempts >= this.maxRetries
        order.status = reachedMax ? 'failed' : 'waiting_for_player'
        order.lastError = reachedMax ? `Exceeded max delivery attempts (${this.maxRetries})` : errorReason
        // On timeout, wait for buyer to whisper "claim" rather than auto-spamming /tpa
        order.nextAttemptAt = Date.now() + (isOfflineChat ? 15000 : 86400000)
        order.updatedAt = Date.now()
        this.saveQueue()
        const msg = reachedMax
          ? `⚠️ Auto-delivery failed after ${this.maxRetries} attempts (${order.lastError}). Staff have been alerted to complete your delivery manually.`
          : (isOfflineChat
              ? `⚠️ Delivery deferred: ${username} appears offline in-game. Whisper "claim" once online.`
              : `⚠️ /tpa to ${username} timed out for Order #${order.orderId}. Whisper "claim" to retry.`)
        order.lastChatMessage = msg
        await this.notifyUpdate(order, { chatMessage: msg })
        return
      }

      await delay(750)

      // Step 2e: Enhanced Safety & Hazard Verification
      const safetyResult = checkAreaSafety(bot, this.safetyRadius, username)
      if (!safetyResult.safe) {
        const hazard = safetyResult.hazard
        this.log(
          `[SAFETY ALERT] Hazard "${hazard.name}" detected at ${hazard.distance}m for ${username}! Aborting drop!`,
          'error'
        )
        safeChat(
          bot,
          `/msg ${username} [Bluxmart] ⚠️ DELIVERY ABORTED! Detected ${hazard.name} nearby! Move to a safe location.`
        )
        // Teleport /home 1 and wait for base arrival before touching Ender Chest (EC-06)
        await this.returnToBaseSafely(bot, startBasePos, 8000)
        if (order.spawners > 0 || order.elytras > 0) {
          await depositBackToEnderChest(bot)
        }
        const reachedMax = order.attempts >= this.maxRetries
        order.status = reachedMax ? 'failed' : 'waiting_for_player'
        order.lastError = `Unsafe drop area: ${hazard.name} within ${hazard.distance} blocks`
        order.nextAttemptAt = Date.now() + 30000
        order.updatedAt = Date.now()
        this.saveQueue()
        const msg = reachedMax
          ? `⚠️ Auto-delivery failed after ${this.maxRetries} attempts (${order.lastError}). Staff have been alerted to complete your delivery manually.`
          : `🚨 Safety Abort for ${username}: Detected ${hazard.name}! Move to a safe spot and whisper "claim".`
        order.lastChatMessage = msg
        await this.notifyUpdate(order, { chatMessage: msg })
        return
      }

      this.log(`[DELIVERY] Area safe around ${username}. Tossing ordered items...`)

      // Step 2f: Drop items with Real-Time Anti-Duplication Decrementing (EC-04)
      const dropAborted = await this.tossOrderedItemsSafely(bot, username, order)

      if (dropAborted) {
        this.log(
          `[DELIVERY] Delivery aborted during drop for ${username}. Returning undelivered balance to Ender Chest.`,
          'warn'
        )
        await this.returnToBaseSafely(bot, startBasePos, 8000)
        await depositBackToEnderChest(bot)
        const reachedMax = order.attempts >= this.maxRetries
        order.status = reachedMax ? 'failed' : 'waiting_for_player'
        order.lastError = 'Delivery interrupted during drop'
        order.nextAttemptAt = Date.now() + 30000
        order.updatedAt = Date.now()
        this.saveQueue()
        const msg = reachedMax
          ? `⚠️ Auto-delivery failed after ${this.maxRetries} attempts (${order.lastError}). Staff have been alerted to complete your delivery manually.`
          : `⚠️ Delivery interrupted while tossing items to ${username}. Remaining balance: ${order.spawners}x Spawners, ${order.elytras}x Elytras. Whisper "claim" to retry.`
        order.lastChatMessage = msg
        await this.notifyUpdate(order, { chatMessage: msg })
        return
      }

      // If order also includes unsupported custom items (otherItemsCount > 0), route remaining custom items to staff
      if (order.otherItemsCount > 0) {
        order.status = 'waiting_for_staff'
        order.lastError = 'Spawners/Elytras delivered; custom catalog items require manual staff handoff'
        order.lastChatMessage =
          '📦 Your money (if any) was processed! Your custom catalog items require manual staff handoff in live chat.'
        order.updatedAt = Date.now()
        this.saveQueue()
        await this.returnToBaseSafely(bot, startBasePos, 5000)
        await this.notifyUpdate(order, {
          chatMessage: order.lastChatMessage
        })
        return
      }

      // Step 2g: Successful Delivery Finalization
      order.itemsDelivered = true
      order.status = 'completed'
      order.updatedAt = Date.now()
      this.markOrderTombstoned(order.orderId)
      this.saveQueue()

      this.log(
        `[DELIVERY] ✅ Order #${order.orderId} successfully delivered to ${username}! Returning home...`,
        'success'
      )
      await this.returnToBaseSafely(bot, startBasePos, 5000)
      safeChat(
        bot,
        `/msg ${username} [Bluxmart] Order #${order.orderId} delivered! Thank you for buying from bluxmart.com!`
      )

      await this.notifyUpdate(order, {
        chatMessage: `✅ Order #${order.orderId} has been successfully delivered in-game to ${username}!`
      })
    }
  }

  async waitForTeleport(bot, username, startBasePos, timeoutMs, getOfflineChat) {
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      const offlineMsg = typeof getOfflineChat === 'function' ? getOfflineChat() : null
      if (offlineMsg) {
        return { success: false, reason: 'offline_chat', message: offlineMsg }
      }
      await delay(500)
      const offlineMsgAfter = typeof getOfflineChat === 'function' ? getOfflineChat() : null
      if (offlineMsgAfter) {
        return { success: false, reason: 'offline_chat', message: offlineMsgAfter }
      }
      if (!bot.entity) return { success: false, reason: 'no_entity' }
      const buyerEntity = bot.players?.[username]?.entity
      const movedFromBase = Boolean(startBasePos && bot.entity.position.distanceTo(startBasePos) > 10)
      const nearBuyer = Boolean(
        buyerEntity?.position && bot.entity.position.distanceTo(buyerEntity.position) <= 16
      )
      if (movedFromBase || nearBuyer) {
        this.log(`[DELIVERY] Teleport confirmed for ${username}! Proceeding with safety check...`)
        return { success: true }
      }
    }
    return { success: false, reason: 'timeout' }
  }

  /**
   * Drops items with Real-Time Quantity Accounting on disk.
   * If an interruption occurs mid-drop, order.spawners and order.elytras
   * are decremented on disk immediately, completely preventing duplication.
   */
  async tossOrderedItemsSafely(bot, username, order) {
    let remainingSpawners = order.spawners || 0
    let remainingElytras = order.elytras || 0

    const buyer = bot.players?.[username]?.entity
    if (!buyer || !buyer.position) {
      this.log(
        `[DELIVERY] Buyer entity for ${username} is missing/invisible! Aborting drop immediately.`,
        'warn'
      )
      return true
    }

    try {
      await bot.lookAt(buyer.position.offset(0, 1.6, 0))
    } catch {}

    // Distance check: ensure buyer is within reachable drop distance
    if (bot.entity.position.distanceTo(buyer.position) > 6.0) {
      this.log(`[DELIVERY] Buyer ${username} is too far away (> 6 blocks). Aborting drop.`, 'warn')
      return true
    }

    const initialHealth = typeof bot.health === 'number' ? bot.health : 20

    for (const item of bot.inventory.items()) {
      if (remainingSpawners <= 0 && remainingElytras <= 0) break

      const isSpawner = remainingSpawners > 0 && matchesCatalogCategory(item.name, 'spawner')
      const isElytra = !isSpawner && remainingElytras > 0 && matchesCatalogCategory(item.name, 'elytra')
      if (!isSpawner && !isElytra) continue

      // Re-verify buyer exists and is within 6.0 blocks before each stack
      const currentBuyer = bot.players?.[username]?.entity
      if (
        !currentBuyer ||
        !currentBuyer.position ||
        bot.entity.position.distanceTo(currentBuyer.position) > 6.0
      ) {
        this.log(
          `[DELIVERY] Buyer ${username} moved > 6 blocks away or disappeared mid-drop. Aborting drop.`,
          'warn'
        )
        return true
      }

      // Re-verify area safety (pistons, lava, buyer weapon drawn, hostile mobs)
      const currentSafety = checkAreaSafety(bot, this.safetyRadius, username)
      if (!currentSafety.safe) {
        this.log(
          `[SAFETY ALERT] Mid-drop hazard detected (${currentSafety.hazard?.name})! Aborting drop immediately.`,
          'error'
        )
        return true
      }

      // Check if bot took damage
      if (typeof bot.health === 'number' && bot.health < initialHealth) {
        this.log(
          `[SAFETY ALERT] Bot took damage during delivery (${bot.health} < ${initialHealth})! Aborting drop immediately.`,
          'error'
        )
        return true
      }

      try {
        await bot.lookAt(currentBuyer.position.offset(0, 1.6, 0))
      } catch {}

      if (isSpawner) {
        const countToToss = Math.min(item.count, remainingSpawners)
        await bot.toss(item.type, null, countToToss)
        remainingSpawners -= countToToss
        order.spawners -= countToToss // Decrement immediately
        order.updatedAt = Date.now()
        this.saveQueue() // Persist immediately to disk
        await delay(350)
      } else if (isElytra) {
        const countToToss = Math.min(item.count, remainingElytras)
        await bot.toss(item.type, null, countToToss)
        remainingElytras -= countToToss
        order.elytras -= countToToss // Decrement immediately
        order.updatedAt = Date.now()
        this.saveQueue() // Persist immediately to disk
        await delay(350)
      }
    }

    if (remainingSpawners > 0 || remainingElytras > 0) {
      this.log(
        `[DELIVERY] Incomplete toss! Missing ${remainingSpawners}x Spawners, ${remainingElytras}x Elytras.`,
        'warn'
      )
      return true
    }

    return false
  }
}
