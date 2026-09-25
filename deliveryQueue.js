import fs from 'fs'
import path from 'path'
import { checkAreaSafety } from './safety.js'
import {
  withdrawFromEnderChest,
  depositBackToEnderChest,
  matchesCatalogCategory
} from './enderchest.js'

const DEFAULT_QUEUE_FILE = path.resolve('./delivery-queue.json')
const FALLBACK_QUEUE_FILE = path.resolve('./orders-queue.json')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class DeliveryQueueManager {
  constructor(botGetter, config = {}) {
    this.getBot = botGetter
    this.queueFilePath = config.queueFilePath || process.env.QUEUE_FILE_PATH || DEFAULT_QUEUE_FILE
    this.safeReturnCommand = config.safeReturnCommand || process.env.SAFE_RETURN_COMMAND || '/home'
    this.safetyRadius = Number(config.safetyRadius || process.env.SAFETY_RADIUS || 5)
    this.tpaTimeoutMs = Number(config.tpaTimeoutMs || process.env.TPA_TIMEOUT_MS || 60000)
    this.maxRetries = Number(config.maxRetries || process.env.MAX_DELIVERY_RETRIES || 5)
    this.onLog = config.onLog || ((msg) => console.log(msg))
    this.onOrderUpdate = config.onOrderUpdate || config.onStatusChange || (() => {})
    this.onStatusChange = config.onStatusChange || config.onOrderUpdate || (() => {})
    this.processing = false
    this.queue = this.loadQueue()
  }

  log(msg, level = 'info') {
    this.onLog(msg, level)
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

  loadQueue() {
    try {
      if (fs.existsSync(this.queueFilePath)) {
        return JSON.parse(fs.readFileSync(this.queueFilePath, 'utf8'))
      }
      if (fs.existsSync(FALLBACK_QUEUE_FILE)) {
        return JSON.parse(fs.readFileSync(FALLBACK_QUEUE_FILE, 'utf8'))
      }
    } catch (err) {
      console.error(`[QUEUE] Failed to load queue file (${this.queueFilePath}):`, err.message)
    }
    return []
  }

  saveQueue() {
    try {
      fs.writeFileSync(this.queueFilePath, JSON.stringify(this.queue, null, 2), 'utf8')
    } catch (err) {
      console.error(`[QUEUE] Failed to write queue file (${this.queueFilePath}):`, err.message)
    }
  }

  /**
   * Alias for enqueueOrder to ensure seamless interoperability with index.js and webhooks.
   */
  enqueue(order) {
    return this.enqueueOrder(order)
  }

  /**
   * Enqueues a verified order for in-game delivery.
   * Deduplicates by orderId so repeated webhook retries or cloud polls never double-deliver.
   */
  enqueueOrder(order) {
    const rawId = String(order.orderId || order.id || `ord_${Date.now()}`)
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

    const entry = {
      orderId: rawId,
      id: rawId,
      minecraftUsername: rawUsername,
      recipient: rawUsername,
      moneyAmount,
      money: moneyAmount,
      spawners,
      elytras,
      otherItemsCount,
      hasNonMoneyItems,
      itemsSummary: order.itemsSummary || '',
      moneyDelivered: moneyAmount === 0,
      itemsDelivered: !hasNonMoneyItems,
      attempts: 0,
      status: 'pending',
      lastError: null,
      createdAt: order.createdAt || Date.now(),
      updatedAt: Date.now()
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
   * Retries an order when player joins or whispers 'claim'
   */
  retryPendingForPlayer(username) {
    if (!username) return false
    const lower = username.toLowerCase().trim()
    const target = this.queue.find(
      (o) =>
        (((o.minecraftUsername && o.minecraftUsername.toLowerCase() === lower) ||
          (o.recipient && o.recipient.toLowerCase() === lower))) &&
        o.status !== 'completed'
    )
    if (target) {
      target.status = 'pending'
      target.attempts = 0
      target.lastError = null
      target.updatedAt = Date.now()
      this.saveQueue()
      this.log(`[QUEUE] Player ${username} requested claim. Re-queued Order #${target.orderId || target.id}`)
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
      waitingCount: this.queue.filter((o) => o.status === 'waiting_for_player').length,
      completedCount: this.queue.filter((o) => o.status === 'completed').length,
      orders: this.queue.map((o) => ({
        ...o,
        isPlayerOnline: onlinePlayers.has((o.minecraftUsername || o.recipient || '').toLowerCase())
      }))
    }
  }

  async processNext() {
    if (this.processing) return
    const bot = this.getBot()
    if (!bot || !bot.entity) return

    // Priority 1: Any order that still needs Money sent (since Money can be sent OFFLINE immediately!)
    let nextOrder = this.queue.find(
      (o) => o.status !== 'completed' && !o.moneyDelivered && (o.moneyAmount > 0 || o.money > 0)
    )

    // Priority 2: Any order that needs physical items delivered (Buyer must be in-game)
    if (!nextOrder) {
      nextOrder = this.queue.find(
        (o) =>
          (o.status === 'pending' || o.status === 'waiting_for_player' || o.status === 'queued') &&
          !o.itemsDelivered &&
          o.attempts < this.maxRetries
      )
    }

    if (!nextOrder) return

    this.processing = true
    try {
      await this.executeOrder(bot, nextOrder)
    } catch (err) {
      this.log(`[DELIVERY] Error processing order ${nextOrder.orderId}: ${err.message}`, 'error')
      nextOrder.lastError = err.message
      nextOrder.updatedAt = Date.now()
      this.saveQueue()
    } finally {
      this.processing = false
      setTimeout(() => this.processNext(), 3000)
    }
  }

  async executeOrder(bot, order) {
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

    // 1. Deliver Money via /pay <username> <amount> — WORKS EVEN WHEN PLAYER IS OFFLINE!
    if (!order.moneyDelivered && order.moneyAmount > 0) {
      this.log(
        `[OFFLINE-PAY] Sending $${order.moneyAmount.toLocaleString()} to ${username} via /pay (works offline & online)...`
      )
      bot.chat(`/pay ${username} ${order.moneyAmount}`)
      await delay(1200)
      bot.chat(
        `/msg ${username} [Bluxmart] Paid $${order.moneyAmount.toLocaleString()} for Order #${order.orderId}!`
      )
      order.moneyDelivered = true
      if (!order.hasNonMoneyItems) {
        order.status = 'completed'
      }
      order.updatedAt = Date.now()
      this.saveQueue()

      await this.notifyUpdate(order, {
        chatMessage: order.itemsDelivered
          ? `💸 Paid $${order.moneyAmount.toLocaleString()} to ${username} via /pay! Your money-only order #${order.orderId} is now complete (no need to be online).`
          : `💸 Paid $${order.moneyAmount.toLocaleString()} to ${username} via /pay (sent offline/online)! Now waiting for ${username} to be in-game on donutsmp.net for physical item delivery.`
      })
    }

    // 2. Deliver Physical Items (Anything bought other than money) — PLAYER MUST BE IN-GAME
    if (!order.itemsDelivered && order.hasNonMoneyItems) {
      order.status = 'delivering'
      order.attempts += 1
      order.updatedAt = Date.now()
      this.saveQueue()
      await this.notifyUpdate(order)

      if (order.spawners > 0 || order.elytras > 0) {
        // Step 2a: Ensure bot is at its safe Ender Chest base first
        bot.chat(this.safeReturnCommand)
        await delay(2500)

        // Step 2b: Open physical Ender Chest at base and withdraw exact Spawner & Elytra quantities
        this.log(
          `[DELIVERY] Withdrawing ${order.spawners}x Spawner and ${order.elytras}x Elytra from physical Ender Chest...`
        )
        await withdrawFromEnderChest(bot, {
          spawners: order.spawners,
          elytras: order.elytras
        })
      }

      const startBasePos = bot.entity.position.clone()

      // Step 2c: Send /tpa <username> and instruct buyer to be in-game & 5 blocks away from lava/campfires
      this.log(`[DELIVERY] Sending /tpa ${username} (Buyer must be in-game on donutsmp.net)...`)
      bot.chat(`/tpa ${username}`)
      await delay(600)
      bot.chat(
        `/msg ${username} [Bluxmart] Order #${order.orderId} ready! Accept /tpa in-game in a SAFE spot (NO lava or campfires within ${this.safetyRadius} blocks).`
      )

      // Step 2d: Wait for teleport completion
      const tpSuccess = await this.waitForTeleport(bot, username, startBasePos, this.tpaTimeoutMs)
      if (!tpSuccess) {
        this.log(
          `[DELIVERY] /tpa to ${username} timed out (player offline or did not accept). Returning items to Ender Chest.`,
          'warn'
        )
        bot.chat(
          `/msg ${username} [Bluxmart] /tpa expired for Order #${order.orderId}. Be in-game on donutsmp.net and whisper "claim" to retry!`
        )
        if (order.spawners > 0 || order.elytras > 0) {
          bot.chat(this.safeReturnCommand)
          await delay(2500)
          await depositBackToEnderChest(bot)
        }
        order.status = 'waiting_for_player'
        order.lastError = 'Waiting for buyer to be in-game and accept /tpa'
        order.updatedAt = Date.now()
        this.saveQueue()
        await this.notifyUpdate(order, {
          chatMessage: `⚠️ We attempted /tpa ${username} on donutsmp.net for Order #${order.orderId}, but you were offline or didn't accept in time. Please log in to donutsmp.net as "${username}" (or whisper "claim" to the bot in-game) to receive your items!`
        })
        return
      }

      await delay(750)

      // Step 2e: 5-BLOCK LAVA & CAMPFIRE SAFETY CHECK
      const safetyResult = checkAreaSafety(bot, this.safetyRadius, username)
      if (!safetyResult.safe) {
        const hazard = safetyResult.hazard
        this.log(
          `[SAFETY ALERT] Hazard "${hazard.name}" detected at ${hazard.distance}m (<= ${this.safetyRadius} blocks) for ${username}! Aborting drop!`,
          'error'
        )
        bot.chat(this.safeReturnCommand)
        await delay(800)
        bot.chat(
          `/msg ${username} [Bluxmart] ⚠️ DELIVERY ABORTED! Detected ${hazard.name} within ${hazard.distance} blocks (must be >${this.safetyRadius} blocks away from lava/campfires). Move to a safe area!`
        )
        if (order.spawners > 0 || order.elytras > 0) {
          await delay(2000)
          await depositBackToEnderChest(bot)
        }
        order.status = 'waiting_for_player'
        order.lastError = `Unsafe area: ${hazard.name} within ${hazard.distance} blocks`
        order.updatedAt = Date.now()
        this.saveQueue()
        await this.notifyUpdate(order, {
          chatMessage: `🚨 Safety Abort for ${username}: Detected ${hazard.name} within ${hazard.distance} blocks! Please move at least ${this.safetyRadius} blocks away from lava/campfires and whisper "claim" in-game to retry.`
        })
        return
      }

      this.log(`[DELIVERY] Area safe around ${username}. Tossing ordered items...`)

      // Step 2f: Drop items
      const dropAborted = await this.tossOrderedItemsSafely(bot, username, {
        spawners: order.spawners,
        elytras: order.elytras
      })

      if (dropAborted) {
        this.log(
          `[DELIVERY] Delivery aborted during drop (player moved/left). Returning items to Ender Chest.`,
          'warn'
        )
        bot.chat(this.safeReturnCommand)
        await delay(2500)
        await depositBackToEnderChest(bot)
        order.status = 'waiting_for_player'
        order.lastError = 'Delivery interrupted during drop'
        order.updatedAt = Date.now()
        this.saveQueue()
        await this.notifyUpdate(order, {
          chatMessage: `⚠️ Delivery interrupted while tossing items to ${username}. Whisper "claim" in-game to retry!`
        })
        return
      }

      order.itemsDelivered = true
      order.status = 'completed'
      order.updatedAt = Date.now()
      this.saveQueue()

      this.log(
        `[DELIVERY] ✅ Order #${order.orderId} successfully delivered to ${username}! Returning home...`,
        'success'
      )
      bot.chat(this.safeReturnCommand)
      await delay(1000)
      bot.chat(
        `/msg ${username} [Bluxmart] Order #${order.orderId} delivered! Thank you for buying from bluxmart.com!`
      )

      await this.notifyUpdate(order, {
        chatMessage: `✅ Order #${order.orderId} has been successfully delivered in-game to ${username}! Enjoy your items.`
      })
    }
  }

  async waitForTeleport(bot, username, startBasePos, timeoutMs) {
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      await delay(500)
      if (bot.entity.position.distanceTo(startBasePos) > 10) {
        this.log(`[DELIVERY] Teleport confirmed for ${username}! Proceeding with safety check...`)
        return true
      }
    }
    return false
  }

  async tossOrderedItemsSafely(bot, username, { spawners, elytras }) {
    let remainingSpawners = spawners
    let remainingElytras = elytras

    const buyer = bot.players[username]?.entity
    if (buyer) {
      try {
        await bot.lookAt(buyer.position.offset(0, 1.6, 0))
      } catch {}
    }

    for (const item of bot.inventory.items()) {
      if (remainingSpawners <= 0 && remainingElytras <= 0) break

      if (remainingSpawners > 0 && matchesCatalogCategory(item.name, 'spawner')) {
        const countToToss = Math.min(item.count, remainingSpawners)
        await bot.toss(item.type, null, countToToss)
        remainingSpawners -= countToToss
        await delay(350)
      } else if (remainingElytras > 0 && matchesCatalogCategory(item.name, 'elytra')) {
        const countToToss = Math.min(item.count, remainingElytras)
        await bot.toss(item.type, null, countToToss)
        remainingElytras -= countToToss
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
