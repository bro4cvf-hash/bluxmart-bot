import { Vec3 } from 'vec3'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Matches whether an item in Mineflayer is a Spawner or Elytra.
 */
export function matchesCatalogCategory(itemName, category) {
  if (!itemName) return false
  const lower = itemName.toLowerCase()
  if (category === 'spawner') {
    return lower === 'spawner' || lower === 'mob_spawner' || lower.endsWith('_spawner')
  }
  if (category === 'elytra') {
    return lower === 'elytra'
  }
  return false
}

/**
 * Counts how many items of a category ('spawner' or 'elytra') the bot currently holds in its inventory.
 */
export function countInventoryCategory(bot, category) {
  if (!bot?.inventory) return 0
  return bot.inventory
    .items()
    .filter((item) => matchesCatalogCategory(item.name, category))
    .reduce((sum, item) => sum + item.count, 0)
}

/**
 * Target points on an Ender Chest block for multi-point raycasting line-of-sight checks.
 * Points are defined relative to the block's origin (0..1).
 */
export const CHEST_TARGET_OFFSETS = [
  // Top lid points
  new Vec3(0.5, 0.88, 0.5),
  new Vec3(0.3, 0.88, 0.3),
  new Vec3(0.7, 0.88, 0.7),
  // North face
  new Vec3(0.5, 0.5, 0.05),
  // South face
  new Vec3(0.5, 0.5, 0.95),
  // West face
  new Vec3(0.05, 0.5, 0.5),
  // East face
  new Vec3(0.95, 0.5, 0.5)
]

/**
 * Checks if an opaque solid block is directly above the Ender Chest.
 * In Minecraft, a chest lid cannot open if an opaque solid block rests directly above it.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('prismarine-block').Block} ecBlock
 * @returns {boolean} True if lid is obstructed
 */
export function isChestLidBlocked(bot, ecBlock) {
  if (!ecBlock?.position) return false
  const blockAbove = bot.blockAt(ecBlock.position.offset(0, 1, 0))
  if (!blockAbove) return false
  const name = (blockAbove.name || '').toLowerCase()
  const NON_BLOCKING = [
    'air', 'slab', 'stair', 'carpet', 'trapdoor', 'door', 'glass', 'pane',
    'chest', 'fence', 'wall', 'sign', 'banner', 'lantern', 'chain', 'torch',
    'flower', 'grass', 'vine', 'ladder', 'rail', 'piston', 'leaf', 'leaves',
    'water', 'lava', 'cauldron', 'hopper', 'anvil', 'scaffolding', 'grindstone',
    'bell', 'candle'
  ]
  if (NON_BLOCKING.some((kw) => name.includes(kw))) return false
  if (blockAbove.boundingBox === 'empty' || blockAbove.transparent) return false
  return blockAbove.boundingBox === 'block'
}

/**
 * Helper to verify whether a block space is clear (air or empty bounding box).
 *
 * @param {import('prismarine-block').Block|null} block
 * @returns {boolean}
 */
export function isBlockClearOrAir(block) {
  if (!block) return false
  return (
    block.name === 'air' ||
    block.name === 'cave_air' ||
    block.name === 'void_air' ||
    block.boundingBox === 'empty'
  )
}

/**
 * Raycasts from bot's eye position to verify clear line-of-sight directly hitting the chest without obstacles.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('prismarine-block').Block} ecBlock
 * @param {Vec3} targetPoint
 * @returns {Promise<boolean>}
 */
export async function raycastToPoint(bot, ecBlock, targetPoint) {
  const eyeHeight = bot.entity?.eyeHeight || 1.62
  const eyePos = bot.entity.position.offset(0, eyeHeight, 0)
  const dir = targetPoint.minus(eyePos)
  const dist = dir.norm()

  if (dist > 5.0) return false

  if (!bot.world || typeof bot.world.raycast !== 'function') {
    return true
  }

  const range = dist + 0.5
  const matcher = (block) => {
    if (!block) return false
    return (
      block.boundingBox === 'block' ||
      (block.shapes && block.shapes.length > 0) ||
      block.name === 'ender_chest'
    )
  }

  try {
    const hit = await bot.world.raycast(eyePos, dir.normalize(), range, matcher)
    if (hit && hit.position && hit.position.equals(ecBlock.position)) {
      return true
    }
  } catch {
    return false
  }

  return false
}

/**
 * Iterates through CHEST_TARGET_OFFSETS to find candidate point with clear line-of-sight.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('prismarine-block').Block} ecBlock
 * @returns {Promise<Vec3|null>}
 */
export async function findClearRaycastTarget(bot, ecBlock) {
  for (const offset of CHEST_TARGET_OFFSETS) {
    const targetPoint = ecBlock.position.offset(offset.x, offset.y, offset.z)
    const hasLineOfSight = await raycastToPoint(bot, ecBlock, targetPoint)
    if (hasLineOfSight) {
      return targetPoint
    }
  }
  return null
}

/**
 * Verifies lid clearance and conducts multi-point raycasting.
 * If initial raycast fails / is obstructed, attempts angle adjustment or stepping closer before failing safely.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('prismarine-block').Block} ecBlock
 * @returns {Promise<Vec3>}
 */
export async function acquireEnderChestTarget(bot, ecBlock) {
  const centerPoint = ecBlock.position.offset(0.5, 0.5, 0.5)

  // 1. Initial multi-point raycast (tests lid, North, South, East, West faces)
  let target = await findClearRaycastTarget(bot, ecBlock)
  if (target) return target

  // 2. Initial raycast failed/obstructed: attempt to adjust angle
  if (typeof bot.lookAt === 'function') {
    try {
      await bot.lookAt(centerPoint, false)
      await delay(80)
      target = await findClearRaycastTarget(bot, ecBlock)
      if (target) return target
    } catch {}
  }

  // 3. Attempt to take a step closer towards the chest
  if (typeof bot.setControlState === 'function') {
    try {
      if (typeof bot.lookAt === 'function') {
        await bot.lookAt(centerPoint, true)
      }
      bot.setControlState('forward', true)
      await delay(160)
      bot.setControlState('forward', false)
      await delay(100)

      target = await findClearRaycastTarget(bot, ecBlock)
      if (target) return target
    } catch {}
  }

  // 4. Fallback to chest center point if within 4.5 blocks (never throw exception before attempting to open)
  return centerPoint
}

/**
 * Normalizes an angle in radians to [-PI, PI].
 */
function normalizeAngle(rad) {
  let a = (rad + Math.PI) % (2 * Math.PI)
  if (a < 0) a += 2 * Math.PI
  return a - Math.PI
}

/**
 * Smoothly interpolates yaw and pitch over 150-250ms across 6-10 steps with easing
 * and small micro-jitter (+-0.005 radians) using bot.look(yaw, pitch, false) with small delays (15-25ms).
 *
 * @param {import('mineflayer').Bot} bot
 * @param {Vec3} targetPoint
 */
export async function smoothLookAt(bot, targetPoint) {
  const eyeHeight = bot.entity?.eyeHeight || 1.62
  const eyePos = bot.entity.position.offset(0, eyeHeight, 0)
  const delta = targetPoint.minus(eyePos)

  const targetYaw = Math.atan2(-delta.x, -delta.z)
  const groundDistance = Math.sqrt(delta.x * delta.x + delta.z * delta.z)
  const targetPitch = Math.atan2(delta.y, groundDistance)

  const startYaw = bot.entity?.yaw ?? 0
  const startPitch = bot.entity?.pitch ?? 0

  const deltaYaw = normalizeAngle(targetYaw - startYaw)
  const deltaPitch = targetPitch - startPitch

  // 6-10 steps
  const steps = Math.floor(Math.random() * 5) + 6

  // Total duration 150-250ms
  const targetDurationMs = 150 + Math.random() * 100
  const baseStepDelay = Math.max(15, Math.min(25, Math.round(targetDurationMs / steps)))

  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    // Sinusoidal ease-in-out
    const easedT = 0.5 * (1 - Math.cos(Math.PI * t))

    // Micro-jitter (+-0.005 radians) on intermediate steps
    const jitterYaw = i < steps ? (Math.random() - 0.5) * 0.01 : 0
    const jitterPitch = i < steps ? (Math.random() - 0.5) * 0.01 : 0

    const currentYaw = startYaw + deltaYaw * easedT + jitterYaw
    const currentPitch = startPitch + deltaPitch * easedT + jitterPitch

    if (typeof bot.look === 'function') {
      try {
        await Promise.race([
          bot.look(currentYaw, currentPitch, false),
          delay(100)
        ])
      } catch {
        try { await bot.look(currentYaw, currentPitch, true) } catch {}
      }
    }

    const stepDelay = Math.max(15, Math.min(25, baseStepDelay + Math.floor((Math.random() - 0.5) * 6)))
    await delay(stepDelay)
  }

  // Ensure exact final orientation is reached
  if (typeof bot.look === 'function') {
    try {
      await Promise.race([
        bot.look(startYaw + deltaYaw, targetPitch, false),
        delay(120)
      ])
    } catch {
      try { await bot.look(startYaw + deltaYaw, targetPitch, true) } catch {}
    }
  }
}

export const lookSmoothlyAt = smoothLookAt

/**
 * Safely closes any open container / window on both the bot client and sends
 * the close container (close_window) packet to the server to prevent desyncs
 * before opening an Ender Chest or interacting with storage.
 *
 * @param {import('mineflayer').Bot} bot
 */
export async function closeContainer(bot) {
  if (!bot) return

  // 1. If Mineflayer tracks an open window, close it cleanly
  if (bot.currentWindow) {
    try {
      bot.closeWindow(bot.currentWindow)
    } catch {}
    await delay(150)
  }

  // 2. Explicitly send close container packet (close_window) to server
  // to ensure server-side containerMenu is reset to inventoryMenu even if
  // client state was desynced or window was already marked closed locally.
  if (typeof bot._client?.write === 'function') {
    try {
      const lastId = bot.currentWindow?.id ?? bot._lastOpenedWindowId
      if (lastId != null && lastId !== 0) {
        bot._client.write('close_window', { windowId: lastId })
      }
      bot._client.write('close_window', { windowId: 0 })
    } catch {}
    await delay(100)
  }

  bot.currentWindow = null
}

/**
 * Finds a nearby physical Ender Chest block within 4.5 blocks, or places one from the bot's inventory.
 *
 * @param {import('mineflayer').Bot} bot
 */
export async function findOrPlaceEnderChest(bot) {
  await closeContainer(bot)
  let ecBlock = bot.findBlock({
    matching: (block) => block && block.name === 'ender_chest' && !isChestLidBlocked(bot, block),
    maxDistance: 4.5
  })

  if (!ecBlock) {
    await delay(300)
    ecBlock = bot.findBlock({
      matching: (block) => block && block.name === 'ender_chest' && !isChestLidBlocked(bot, block),
      maxDistance: 4.5
    })
  }

  // If no clear-lid chest found nearby, fall back to any ender_chest block
  if (!ecBlock) {
    ecBlock = bot.findBlock({
      matching: (block) => block && block.name === 'ender_chest',
      maxDistance: 4.5
    })
  }

  if (ecBlock && !isChestLidBlocked(bot, ecBlock)) return ecBlock

  // Check if bot holds an ender_chest item to place
  const ecItem = bot.inventory?.items?.().find((i) => i.name === 'ender_chest')
  if (!ecItem) {
    throw new Error('No physical ender_chest block found within 4.5 blocks at base and none in bot inventory to place.')
  }

  // Find a solid reference block near the bot's feet to place the Ender Chest on
  const botPos = bot.entity.position.floored()
  const offsets = [
    new Vec3(1, -1, 0),
    new Vec3(-1, -1, 0),
    new Vec3(0, -1, 1),
    new Vec3(0, -1, -1)
  ]

  for (const offset of offsets) {
    const floorBlock = bot.blockAt(botPos.plus(offset))
    const chestSpot = bot.blockAt(botPos.plus(offset).offset(0, 1, 0))
    const lidSpace = bot.blockAt(botPos.plus(offset).offset(0, 2, 0))

    if (
      floorBlock &&
      floorBlock.boundingBox === 'block' &&
      isBlockClearOrAir(chestSpot) &&
      isBlockClearOrAir(lidSpace)
    ) {
      await bot.equip(ecItem, 'hand')
      await bot.placeBlock(floorBlock, new Vec3(0, 1, 0))
      await delay(400)
      ecBlock = bot.findBlock({
        matching: (block) => block && block.name === 'ender_chest',
        maxDistance: 4.5
      })
      if (ecBlock) return ecBlock
    }
  }

  throw new Error('Could not find a suitable block surface with clear lid space to place the physical Ender Chest.')
}

export async function openEnderChestSafely(bot, ecBlock, timeoutMs = 8000) {
  if (!bot) throw new Error('Bot missing')

  await closeContainer(bot)

  // Ensure controls & sneak are released locally and via entity_action packet
  if (typeof bot.clearControlStates === 'function') {
    bot.clearControlStates()
  }
  if (typeof bot._client?.write === 'function' && bot.entity?.id) {
    try {
      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: 1, // stop sneaking
        jumpBoost: 0
      })
    } catch {}
  }

  // Strategy 1: Try /ec command (DonutSMP default - opens Ender Chest GUI instantly without physical block/lid obstacles)
  const tryOpenViaCommand = async (cmdTimeout = 2500) => {
    if (bot._ecCommandSupported === false) return null

    const cleanups = []
    try {
      const windowPromise = new Promise((resolve) => {
        const winHandler = (win) => {
          if (win) {
            if (win.id != null) bot._lastOpenedWindowId = win.id
            resolve(win)
          }
        }
        bot.once('windowOpen', winHandler)
        cleanups.push(() => bot.removeListener('windowOpen', winHandler))

        const chatHandler = (message) => {
          const text = typeof message === 'string' ? message : (message?.toString?.() || '')
          if (/This command does not exist|Unknown command|Unknown or incomplete command|do not have permission/i.test(text)) {
            bot._ecCommandSupported = false
            resolve(null)
          }
        }
        bot.on('message', chatHandler)
        cleanups.push(() => bot.removeListener('message', chatHandler))
      })

      if (typeof bot.chat === 'function') {
        bot.chat('/ec')
      }

      const win = await Promise.race([
        windowPromise,
        delay(cmdTimeout).then(() => null)
      ])
      return win
    } catch {
      return null
    } finally {
      for (const fn of cleanups) {
        try { fn() } catch {}
      }
    }
  }

  const cmdWin = bot._ecCommandSupported === false ? null : await tryOpenViaCommand(2000)
  if (cmdWin) return cmdWin

  // Strategy 2: Physical block interaction
  if (!ecBlock) {
    throw new Error('Ender Chest block missing for physical interaction')
  }

  const chestCenter = ecBlock.position.offset(0.5, 0.5, 0.5)

  // 1. Move within comfortable reach (<= 2.6m) if needed
  if (bot.entity?.position) {
    const dist = bot.entity.position.distanceTo(chestCenter)
    if (dist > 2.6 && typeof bot.setControlState === 'function') {
      if (typeof bot.lookAt === 'function') {
        try {
          await Promise.race([bot.lookAt(chestCenter, false), delay(200)])
        } catch {
          try { await bot.lookAt(chestCenter, true) } catch {}
        }
      }
      bot.setControlState('forward', true)
      await delay(Math.min(350, Math.max(100, Math.floor((dist - 2.0) * 200))))
      bot.setControlState('forward', false)
      await delay(120)
    }
  }

  // 2. Select an empty hotbar slot if available so hand is empty (prevents accidental block placing/eating)
  if (bot.inventory && typeof bot.setQuickBarSlot === 'function') {
    const emptySlot = [0, 1, 2, 3, 4, 5, 6, 7, 8].find(
      (slot) => !bot.inventory.slots[bot.inventory.hotbarStart + slot]
    )
    if (emptySlot !== undefined) {
      bot.setQuickBarSlot(emptySlot)
      await delay(50)
    }
  }

  // 3. Acquire best target point on the chest (lid or face)
  let targetPoint = null
  try {
    targetPoint = await acquireEnderChestTarget(bot, ecBlock)
  } catch {}
  if (!targetPoint) {
    targetPoint = ecBlock.position.offset(0.5, 0.88, 0.5)
  }

  // Determine direction & cursor position
  let direction = new Vec3(0, 1, 0)
  const relY = targetPoint.y - ecBlock.position.y
  const relX = targetPoint.x - ecBlock.position.x
  const relZ = targetPoint.z - ecBlock.position.z

  if (relY >= 0.7) {
    direction = new Vec3(0, 1, 0) // Up / top lid
  } else if (relZ <= 0.2) {
    direction = new Vec3(0, 0, -1) // North
  } else if (relZ >= 0.8) {
    direction = new Vec3(0, 0, 1) // South
  } else if (relX <= 0.2) {
    direction = new Vec3(-1, 0, 0) // West
  } else if (relX >= 0.8) {
    direction = new Vec3(1, 0, 0) // East
  }
  const cursorPos = new Vec3(
    Math.max(0.1, Math.min(0.9, relX)),
    Math.max(0.1, Math.min(0.9, relY)),
    Math.max(0.1, Math.min(0.9, relZ))
  )

  // 4. Look directly at the Ender Chest before right clicking
  if (typeof smoothLookAt === 'function') {
    await smoothLookAt(bot, targetPoint)
  }
  if (typeof bot.lookAt === 'function') {
    try {
      await Promise.race([
        bot.lookAt(targetPoint, false),
        delay(300)
      ])
    } catch {
      try { await bot.lookAt(targetPoint, true) } catch {}
    }
  }
  await delay(180)

  // 5. Primary attempt: open container
  const attemptTimeout = Math.max(3000, Math.floor(timeoutMs / 2))
  try {
    await closeContainer(bot)
    let timer
    return await Promise.race([
      bot.openContainer(ecBlock, direction, cursorPos),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Initial openContainer timed out')), attemptTimeout)
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  } catch (err) {
    // 6. Fallback retry: check /ec command again or re-orient directly at center
    await closeContainer(bot)

    const cmdWinRetry = bot._ecCommandSupported !== false ? await tryOpenViaCommand(2000) : null
    if (cmdWinRetry) return cmdWinRetry

    const retryTarget = ecBlock.position.offset(0.5, 0.5, 0.5)
    if (typeof smoothLookAt === 'function') {
      await smoothLookAt(bot, retryTarget)
    }
    if (typeof bot.lookAt === 'function') {
      try {
        await Promise.race([
          bot.lookAt(retryTarget, false),
          delay(300)
        ])
      } catch {
        try { await bot.lookAt(retryTarget, true) } catch {}
      }
    }
    await delay(180)

    let fallbackTimer
    await closeContainer(bot)
    return await Promise.race([
      bot.openContainer(ecBlock, new Vec3(0, 1, 0), new Vec3(0.5, 0.5, 0.5)),
      new Promise((_, reject) => {
        fallbackTimer = setTimeout(
          () =>
            reject(
              new Error(
                `Timed out waiting for Ender Chest container window to open (${Math.round(timeoutMs / 1000)}s)`
              )
            ),
          attemptTimeout
        )
      })
    ]).finally(() => {
      if (fallbackTimer) clearTimeout(fallbackTimer)
    })
  }
}

/**
 * Sanitizes the bot's inventory by depositing any unauthorized/stray items (preserving 'ender_chest')
 * and any excess spawners or elytras beyond the allowed amounts into the Ender Chest.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ spawners?: number, elytras?: number }} [allowedItems={ spawners: 0, elytras: 0 }]
 * @param {object} [options={}]
 * @returns {Promise<{ sanitized: boolean, excessSpawners: number, excessElytras: number, strayCount: number }>}
 */
export async function sanitizeBotInventory(bot, allowedItems = { spawners: 0, elytras: 0 }, options = {}) {
  const allowedSpawners = Math.max(0, Number(allowedItems?.spawners) || 0)
  const allowedElytras = Math.max(0, Number(allowedItems?.elytras) || 0)

  // Single-pass analysis: counts spawners, elytras, and finds stray/unauthorized items (preserving 'ender_chest')
  const invItems = bot.inventory?.items?.() || []
  let totalSpawners = 0
  let totalElytras = 0
  const strayItems = []

  for (const item of invItems) {
    if (matchesCatalogCategory(item.name, 'spawner')) {
      totalSpawners += item.count
    } else if (matchesCatalogCategory(item.name, 'elytra')) {
      totalElytras += item.count
    } else if (item.name !== 'ender_chest') {
      strayItems.push(item)
    }
  }

  const excessSpawners = Math.max(0, totalSpawners - allowedSpawners)
  const excessElytras = Math.max(0, totalElytras - allowedElytras)

  // Fast-path: if no excess and no stray items, return immediately without opening chest
  if (excessSpawners === 0 && excessElytras === 0 && strayItems.length === 0) {
    return {
      sanitized: false,
      excessSpawners: 0,
      excessElytras: 0,
      strayCount: 0
    }
  }

  let container = options?.container || null
  const shouldClose = !container

  if (!container) {
    await closeContainer(bot)
    const ecBlock = await findOrPlaceEnderChest(bot)
    container = await openEnderChestSafely(bot, ecBlock, options?.timeoutMs || 8000)
  }

  try {
    await delay(300)

    // Deposit all stray items
    while (true) {
      const stray = bot.inventory.items().find(
        (i) => i.name !== 'ender_chest' &&
               !matchesCatalogCategory(i.name, 'spawner') &&
               !matchesCatalogCategory(i.name, 'elytra')
      )
      if (!stray) break
      await container.deposit(stray.type, stray.metadata ?? null, stray.count)
      await delay(150)
    }

    // Deposit excess spawners
    let remainingExcessSpawners = excessSpawners
    while (remainingExcessSpawners > 0) {
      const item = bot.inventory.items().find((i) => matchesCatalogCategory(i.name, 'spawner'))
      if (!item) break
      const depositCount = Math.min(remainingExcessSpawners, item.count)
      await container.deposit(item.type, item.metadata ?? null, depositCount)
      remainingExcessSpawners -= depositCount
      await delay(150)
    }

    // Deposit excess elytras
    let remainingExcessElytras = excessElytras
    while (remainingExcessElytras > 0) {
      const item = bot.inventory.items().find((i) => matchesCatalogCategory(i.name, 'elytra'))
      if (!item) break
      const depositCount = Math.min(remainingExcessElytras, item.count)
      await container.deposit(item.type, item.metadata ?? null, depositCount)
      remainingExcessElytras -= depositCount
      await delay(150)
    }
  } finally {
    if (shouldClose && container) {
      try {
        container.close()
      } catch {}
      await delay(200)
    }
  }

  return {
    sanitized: true,
    excessSpawners,
    excessElytras,
    strayCount: strayItems.length
  }
}

/**
 * Opens the physical Ender Chest at the bot's safe base and withdraws the exact required
 * counts of spawners and elytras into the bot's main inventory.
 * If stock is insufficient, automatically rolls back any partial withdrawal and deposits back.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ spawners: number, elytras: number }} needed
 */
export async function withdrawFromEnderChest(bot, needed) {
  await closeContainer(bot)

  const targetSpawners = Math.max(0, Number(needed?.spawners) || 0)
  const targetElytras = Math.max(0, Number(needed?.elytras) || 0)

  const initialSpawners = countInventoryCategory(bot, 'spawner')
  const initialElytras = countInventoryCategory(bot, 'elytra')
  const initialStrays = (bot.inventory?.items?.() || []).filter(
    (item) => item.name !== 'ender_chest' &&
              !matchesCatalogCategory(item.name, 'spawner') &&
              !matchesCatalogCategory(item.name, 'elytra')
  )

  if (
    initialSpawners === targetSpawners &&
    initialElytras === targetElytras &&
    initialStrays.length === 0
  ) {
    return {
      withdrawnSpawners: 0,
      withdrawnElytras: 0,
      inventorySpawners: initialSpawners,
      inventoryElytras: initialElytras
    }
  }

  const ecBlock = await findOrPlaceEnderChest(bot)
  const container = await openEnderChestSafely(bot, ecBlock, 8000)

  let withdrawnSpawners = 0
  let withdrawnElytras = 0

  try {
    await delay(350)

    // Reconcile excess and deposit any stray items into the Ender Chest first
    await sanitizeBotInventory(bot, { spawners: targetSpawners, elytras: targetElytras }, { container })

    const currentSpawners = countInventoryCategory(bot, 'spawner')
    const currentElytras = countInventoryCategory(bot, 'elytra')

    const missingSpawners = Math.max(0, targetSpawners - currentSpawners)
    const missingElytras = Math.max(0, targetElytras - currentElytras)

    if (missingSpawners > 0 || missingElytras > 0) {
      if (typeof bot.inventory?.emptySlotCount === 'function' && bot.inventory.emptySlotCount() < 1) {
        throw new Error('Bot inventory is full! Clear slots before withdrawing items.')
      }

      const spawnersAvailable = container
        .containerItems()
        .filter((item) => matchesCatalogCategory(item.name, 'spawner'))
        .reduce((sum, item) => sum + item.count, 0)
      const elytrasAvailable = container
        .containerItems()
        .filter((item) => matchesCatalogCategory(item.name, 'elytra'))
        .reduce((sum, item) => sum + item.count, 0)

      if (spawnersAvailable < missingSpawners || elytrasAvailable < missingElytras) {
        throw new Error(
          `Insufficient physical items in Ender Chest: order requires ${targetSpawners} Spawner (${missingSpawners} missing), ${targetElytras} Elytra (${missingElytras} missing); Ender Chest only has ${spawnersAvailable} Spawner, ${elytrasAvailable} Elytra.`
        )
      }

      let remainingSpawnersToPull = missingSpawners
      let remainingElytrasToPull = missingElytras

      for (const item of container.containerItems()) {
        if (remainingSpawnersToPull <= 0 && remainingElytrasToPull <= 0) break

        if (remainingSpawnersToPull > 0 && matchesCatalogCategory(item.name, 'spawner')) {
          const takeCount = Math.min(remainingSpawnersToPull, item.count)
          await container.withdraw(item.type, item.metadata ?? null, takeCount)
          remainingSpawnersToPull -= takeCount
          await delay(200)
        } else if (remainingElytrasToPull > 0 && matchesCatalogCategory(item.name, 'elytra')) {
          const takeCount = Math.min(remainingElytrasToPull, item.count)
          await container.withdraw(item.type, item.metadata ?? null, takeCount)
          remainingElytrasToPull -= takeCount
          await delay(200)
        }
      }

      if (remainingSpawnersToPull > 0 || remainingElytrasToPull > 0) {
        // Automatic Rollback of partial withdrawals (EC-09)
        for (const item of bot.inventory.items()) {
          if (matchesCatalogCategory(item.name, 'spawner') || matchesCatalogCategory(item.name, 'elytra')) {
            try {
              await container.deposit(item.type, item.metadata ?? null, item.count)
            } catch {}
          }
        }

        throw new Error(
          `Failed to withdraw full order: ${remainingSpawnersToPull} spawners and ${remainingElytrasToPull} elytras could not be retrieved.`
        )
      }

      withdrawnSpawners = missingSpawners
      withdrawnElytras = missingElytras
    }
  } finally {
    try {
      container.close()
    } catch {}
  }

  await delay(250)

  // Post-condition check:
  // Verify countInventoryCategory(bot, 'spawner') === targetSpawners
  // Verify countInventoryCategory(bot, 'elytra') === targetElytras
  // Verify bot.inventory.items() has ZERO stray items.
  // If violated, throw Error.
  const finalSpawners = countInventoryCategory(bot, 'spawner')
  const finalElytras = countInventoryCategory(bot, 'elytra')
  const finalStrays = (bot.inventory?.items?.() || []).filter(
    (item) => item.name !== 'ender_chest' &&
              !matchesCatalogCategory(item.name, 'spawner') &&
              !matchesCatalogCategory(item.name, 'elytra')
  )

  if (finalSpawners !== targetSpawners) {
    throw new Error(
      `Post-condition failed: expected ${targetSpawners} spawners in inventory, found ${finalSpawners}`
    )
  }
  if (finalElytras !== targetElytras) {
    throw new Error(
      `Post-condition failed: expected ${targetElytras} elytras in inventory, found ${finalElytras}`
    )
  }
  if (finalStrays.length > 0) {
    const strayNames = finalStrays.map((i) => `${i.name}x${i.count}`).join(', ')
    throw new Error(`Post-condition failed: bot inventory contains stray items: ${strayNames}`)
  }

  return {
    withdrawnSpawners,
    withdrawnElytras,
    inventorySpawners: finalSpawners,
    inventoryElytras: finalElytras
  }
}

/**
 * Deposits any held Spawners or Elytras and stray items back into the physical Ender Chest at base
 * (used if a buyer canceled, went offline, or was in a lava/campfire trap).
 * Delegates directly to sanitizeBotInventory.
 *
 * @param {import('mineflayer').Bot} bot
 */
export async function depositBackToEnderChest(bot) {
  return await sanitizeBotInventory(bot, { spawners: 0, elytras: 0 })
}

