import fs from 'fs'
import path from 'path'
import { checkAreaSafety } from './safety.js'
import {
  withdrawFromEnderChest,
  depositBackToEnderChest,
  matchesCatalogCategory
} from './enderchest.js'

const QUEUE_FILE = path.resolve('./orders-queue.json')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class DeliveryQueueManager {
  constructor(botGetter, config = {}) {
    this.getBot = botGetter
    this.safeReturnCommand = config.safeReturnCommand || process.env.SAFE_RETURN_COMMAND || '/home'
    this.safetyRadius = Number(config.safetyRadius || process.env.SAFETY_RADIUS || 5)
    this.tpaTimeoutMs = Number(config.tpaTimeoutMs || process.env.TPA_TIMEOUT_MS || 60000)
    this.maxRetries = Number(config.maxRetries || process.env.MAX_DELIVERY_RETRIES || 5)
    this.onLog = config.onLog || ((msg) => console.log(msg))
    this.onOrderUpdate = config.onOrderUpdate || (() => {})
    this.processing = false
    this.queue = this.loadQueue()
  }

  log(msg, level = 'info') {
    this.onLog(msg, level)
  }

  loadQueue() {
    try {
      if (fs.existsSync(QUEUE_FILE)) {
        return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'))
      }
    } catch (err) {
      console.error('[QUEUE] Failed to load orders-queue.json:', err.message)
    }
    return []
  }

  saveQueue() {
    try {
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(this.queue, null, 2), 'utf8')
    } catch (err) {
      console.error('[QUEUE] Failed to write orders-queue.json:', err.message)
    }
  }

  /**
   * Enqueues a verified Stripe order for in-game delivery.
   * Deduplicates by orderId so repeated webhook retries or cloud polls never double-deliver.
   */
  enqueueOrder(order) {
    const existing = this.queue.find((o) => o.orderId === String(order.orderId))
    if (existing) {
      return { status: 'already_queued', order: existing }
    }

    const moneyAmount = Math.max(0, Math.floor(Number(order.moneyAmount) || 0))
    const spawners = Math.max(0, Math.floor(Number(order.spawners) || 0))
    const elytras = Math.max(0, Math.floor(Number(order.elytras) || 0))
    const otherItemsCount = Math.max(0, Math.floor(Number(order.otherItemsCount) || 0))
    const hasNonMoneyItems =
      Boolean(order.hasNonMoneyItems) || spawners > 0 || elytras > 0 || otherItemsCount > 0

    const entry = {
      orderId: String(order.orderId),
      minecraftUsername: String(order.minecraftUsername).trim(),
      moneyAmount,
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

  getQueueStatus() {
    const bot = this.getBot()
    const onlinePlayers = new Set(
      Object.keys(bot?.players || {}).map((p) => p.toLowerCase())
    )
    return {
      processing: this.processing,
      totalOrders: this.queue.length,
      pendingOrders: this.queue.filter((o) => o.status !== 'completed' && o.status !== 'failed')
        .length,
      completedOrders: this.queue.filter((o) => o.status === 'completed').length,
      orders: this.queue
        .slice(-50)
        .reverse()
        .map((o) => ({
          ...o,
          playerOnline: onlinePlayers.has(o.minecraftUsername.toLowerCase())
        }))
    }
  }

  async processNext() {
    if (this.processing) return
    const bot = this.getBot()
    if (!bot || !bot.entity) return

    // Priority 1: Any order that still needs Money sent (since Money can be sent OFFLINE immediately!)
    let nextOrder = this.queue.find(
      (o) => o.status !== 'completed' && !o.moneyDelivered && o.moneyAmount > 0
    )

    // Priority 2: Any order that needs physical items delivered (Buyer must be in-game)
    if (!nextOrder) {
      nextOrder = this.queue.find(
        (o) =>
          (o.status === 'pending' || o.status === 'waiting_for_player') &&
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
    const username = order.minecraftUsername
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
      order.updatedAt = Date.now()
      this.saveQueue()

      await this.onOrderUpdate(order, {
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
        this.saveQueue()
        await this.onOrderUpdate(order, {
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
        this.saveQueue()
        await this.onOrderUpdate(order, {
          chatMessage: `🚨 Safety Abort for ${username}: Detected ${hazard.name} within ${hazard.distance} blocks! Please move at least ${this.safetyRadius} blocks away from lava/campfires in-game.`
        })
        return
      }

      // Step 2f: Look at buyer and toss exact ordered items while continuously checking 5-block safety
      const buyerEntity = bot.players[username]?.entity
      if (buyerEntity) {
        await bot.lookAt(buyerEntity.position.offset(0, 1.2, 0), true)
        await delay(300)
      }

      const dropAborted = await this.tossOrderedItemsSafely(bot, username, {
        spawners: order.spawners,
        elytras: order.elytras
      })

      if (dropAborted) {
        bot.chat(this.safeReturnCommand)
        await delay(2000)
        await depositBackToEnderChest(bot)
        order.status = 'waiting_for_player'
        order.lastError = 'Hazard placed during drop; evacuated to base'
        this.saveQueue()
        return
      }

      order.itemsDelivered = true
      bot.chat(
        `/msg ${username} [Bluxmart] ✅ Delivered your items for Order #${order.orderId}! Thank you for shopping at Bluxmart.com!`
      )
      await delay(500)
      bot.chat(this.safeReturnCommand)
    }

    if (order.moneyDelivered && order.itemsDelivered) {
      order.status = 'completed'
      order.lastError = null
      order.updatedAt = Date.now()
      this.saveQueue()
      this.log(`[DELIVERY] ✅ Order #${order.orderId} for ${username} COMPLETED!`)
      await this.onOrderUpdate(order, {
        chatMessage: `✅ Order #${order.orderId} has been fully delivered in-game to ${username}! Thank you for choosing Bluxmart.com!`
      })
    }
  }

  async waitForTeleport(bot, username, startBasePos, timeoutMs) {
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      if (!bot.entity) return false

      const movedDist = bot.entity.position.distanceTo(startBasePos)
      const buyerEntity = bot.players[username]?.entity
      const distToBuyer = buyerEntity
        ? bot.entity.position.distanceTo(buyerEntity.position)
        : Infinity

      if (movedDist > 8 || distToBuyer <= 7) {
        return true
      }
      await delay(400)
    }
    return false
  }

  async tossOrderedItemsSafely(bot, username, { spawners, elytras }) {
    let remainingSpawners = spawners
    let remainingElytras = elytras

    for (const item of bot.inventory.items()) {
      const liveCheck = checkAreaSafety(bot, this.safetyRadius, username)
      if (!liveCheck.safe) {
        bot.chat(this.safeReturnCommand)
        bot.chat(
          `/msg ${username} [Bluxmart] ⚠️ Emergency stop! ${liveCheck.hazard.name} detected within ${this.safetyRadius} blocks!`
        )
        return true
      }

      if (remainingSpawners > 0 && matchesCatalogCategory(item.name, 'spawner')) {
        const countToToss = Math.min(remainingSpawners, item.count)
        await bot.toss(item.type, item.metadata ?? null, countToToss)
        remainingSpawners -= countToToss
        await delay(250)
      } else if (remainingElytras > 0 && matchesCatalogCategory(item.name, 'elytra')) {
        const countToToss = Math.min(remainingElytras, item.count)
        await bot.toss(item.type, item.metadata ?? null, countToToss)
        remainingElytras -= countToToss
        await delay(250)
      }
    }

    return false
  }
}
