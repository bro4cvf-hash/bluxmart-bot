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
 * Finds a nearby physical Ender Chest block within 4.5 blocks, or places one from the bot's inventory.
 *
 * @param {import('mineflayer').Bot} bot
 */
export async function findOrPlaceEnderChest(bot) {
  let ecBlock = bot.findBlock({
    matching: (block) => block && block.name === 'ender_chest',
    maxDistance: 4.5
  })

  if (ecBlock) return ecBlock

  // Check if bot holds an ender_chest item to place
  const ecItem = bot.inventory.items().find((i) => i.name === 'ender_chest')
  if (!ecItem) {
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
    const airAbove = bot.blockAt(botPos.plus(offset).offset(0, 1, 0))
    if (floorBlock && floorBlock.boundingBox === 'block' && airAbove && airAbove.name === 'air') {
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

  throw new Error('Could not find a suitable block surface to place the physical Ender Chest.')
}

/**
 * Opens the physical Ender Chest at the bot's safe base and withdraws the exact required
 * counts of spawners and elytras into the bot's main inventory BEFORE sending /tpa.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ spawners: number, elytras: number }} needed
 */
export async function withdrawFromEnderChest(bot, needed) {
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

  const ecBlock = await findOrPlaceEnderChest(bot)
  await bot.lookAt(ecBlock.position.offset(0.5, 0.5, 0.5), true)
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
  const spawnersInInv = countInventoryCategory(bot, 'spawner')
  const elytrasInInv = countInventoryCategory(bot, 'elytra')
  if (spawnersInInv === 0 && elytrasInInv === 0) return

  const ecBlock = await findOrPlaceEnderChest(bot)
  await bot.lookAt(ecBlock.position.offset(0.5, 0.5, 0.5), true)
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
