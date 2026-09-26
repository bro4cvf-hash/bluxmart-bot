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
  if (!ecBlock?.position) return true
  const blockAbove = bot.blockAt(ecBlock.position.offset(0, 1, 0))
  if (!blockAbove) return false
  return blockAbove.boundingBox === 'block' && !blockAbove.transparent
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
  const eyeHeight = bot.entity?.height || 1.62
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
  if (isChestLidBlocked(bot, ecBlock)) {
    const above = bot.blockAt(ecBlock.position.offset(0, 1, 0))
    throw new Error(
      `Ender Chest lid is obstructed by solid opaque block (${above?.name || 'unknown'}) directly above it.`
    )
  }

  // 1. Initial multi-point raycast
  let target = await findClearRaycastTarget(bot, ecBlock)
  if (target) return target

  // 2. Initial raycast failed/obstructed: attempt to adjust angle
  const centerPoint = ecBlock.position.offset(0.5, 0.5, 0.5)
  if (typeof bot.lookAt === 'function') {
    try {
      await bot.lookAt(centerPoint, false)
      await delay(80)
      target = await findClearRaycastTarget(bot, ecBlock)
      if (target) return target
    } catch {}
  }

  // 3. Attempt to take a step closer towards the chest
  const dist = bot.entity.position.distanceTo(ecBlock.position)
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

  // 4. Fallback to center point if within reach
  if (bot.entity && bot.entity.position && bot.entity.position.distanceTo(ecBlock.position) <= 4.5) {
    return centerPoint
  }

  throw new Error(
    `Cannot establish clear line-of-sight to Ender Chest at ${ecBlock.position} - all target points obstructed.`
  )
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
  const eyeHeight = bot.entity?.height || 1.62
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
      await bot.look(currentYaw, currentPitch, false)
    }

    const stepDelay = Math.max(15, Math.min(25, baseStepDelay + Math.floor((Math.random() - 0.5) * 6)))
    await delay(stepDelay)
  }
}

export const lookSmoothlyAt = smoothLookAt

/**
 * Finds a nearby physical Ender Chest block within 4.5 blocks, or places one from the bot's inventory.
 *
 * @param {import('mineflayer').Bot} bot
 */
export async function findOrPlaceEnderChest(bot) {
  if (bot.currentWindow) {
    try { bot.closeWindow(bot.currentWindow) } catch {}
    await delay(200)
  }
  let ecBlock = bot.findBlock({
    matching: (block) => block && block.name === 'ender_chest' && !isChestLidBlocked(bot, block),
    maxDistance: 4.5
  })

  if (ecBlock) return ecBlock

  // Check if bot holds an ender_chest item to place
  const ecItem = bot.inventory?.items?.().find((i) => i.name === 'ender_chest')
  if (!ecItem) {
    const blockedChest = bot.findBlock({
      matching: (block) => block && block.name === 'ender_chest',
      maxDistance: 4.5
    })
    if (blockedChest) {
      throw new Error(
        `Ender Chest at ${blockedChest.position} cannot be opened (lid obstructed), and bot has no spare Ender Chest.`
      )
    }
    throw new Error('No physical ender_chest block found within 4.5 blocks and none in bot inventory.')
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
        matching: (block) => block && block.name === 'ender_chest' && !isChestLidBlocked(bot, block),
        maxDistance: 4.5
      })
      if (ecBlock) return ecBlock
    }
  }

  throw new Error('Could not find a suitable block surface with clear lid space to place the physical Ender Chest.')
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
  if (bot.currentWindow) {
    try { bot.closeWindow(bot.currentWindow) } catch {}
    await delay(200)
  }
  const targetSpawners = Math.max(0, Number(needed.spawners) || 0)
  const targetElytras = Math.max(0, Number(needed.elytras) || 0)

  const currentSpawners = countInventoryCategory(bot, 'spawner')
  const currentElytras = countInventoryCategory(bot, 'elytra')

  const missingSpawners = Math.max(0, targetSpawners - currentSpawners)
  const missingElytras = Math.max(0, targetElytras - currentElytras)

  if (missingSpawners === 0 && missingElytras === 0) {
    return {
      withdrawnSpawners: 0,
      withdrawnElytras: 0,
      inventorySpawners: currentSpawners,
      inventoryElytras: currentElytras
    }
  }

  // Pre-flight check: bot inventory space
  if (typeof bot.inventory?.emptySlotCount === 'function' && bot.inventory.emptySlotCount() < 1) {
    throw new Error('Bot inventory is full! Clear slots before withdrawing items.')
  }

  const ecBlock = await findOrPlaceEnderChest(bot)
  const targetPoint = await acquireEnderChestTarget(bot, ecBlock)
  await smoothLookAt(bot, targetPoint)
  await delay(120 + Math.floor(Math.random() * 80))
  const container = await bot.openContainer(ecBlock)

  try {
    await delay(350)

    let remainingSpawnersToPull = missingSpawners
    let remainingElytrasToPull = missingElytras

    for (const item of container.containerItems()) {
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

      if (remainingSpawnersToPull > 0) {
        throw new Error(
          `Insufficient Spawners in Ender Chest! Needed ${missingSpawners} more, still short by ${remainingSpawnersToPull}.`
        )
      }
      if (remainingElytrasToPull > 0) {
        throw new Error(
          `Insufficient Elytras in Ender Chest! Needed ${missingElytras} more, still short by ${remainingElytrasToPull}.`
        )
      }
    }
  } finally {
    try {
      container.close()
    } catch {
      // ignore close errors
    }
  }

  await delay(250)

  return {
    withdrawnSpawners: missingSpawners,
    withdrawnElytras: missingElytras,
    inventorySpawners: countInventoryCategory(bot, 'spawner'),
    inventoryElytras: countInventoryCategory(bot, 'elytra')
  }
}

/**
 * Deposits any held Spawners or Elytras back into the physical Ender Chest at base
 * (used if a buyer canceled, went offline, or was in a lava/campfire trap).
 */
export async function depositBackToEnderChest(bot) {
  if (bot.currentWindow) {
    try { bot.closeWindow(bot.currentWindow) } catch {}
    await delay(200)
  }
  const spawnersInInv = countInventoryCategory(bot, 'spawner')
  const elytrasInInv = countInventoryCategory(bot, 'elytra')
  if (spawnersInInv === 0 && elytrasInInv === 0) return

  const ecBlock = await findOrPlaceEnderChest(bot)
  const targetPoint = await acquireEnderChestTarget(bot, ecBlock)
  await smoothLookAt(bot, targetPoint)
  await delay(120 + Math.floor(Math.random() * 80))
  const container = await bot.openContainer(ecBlock)

  try {
    await delay(300)
    for (const item of bot.inventory.items()) {
      if (
        matchesCatalogCategory(item.name, 'spawner') ||
        matchesCatalogCategory(item.name, 'elytra')
      ) {
        await container.deposit(item.type, item.metadata ?? null, item.count)
        await delay(150)
      }
    }
  } finally {
    try {
      container.close()
    } catch {
      // ignore
    }
  }
}
