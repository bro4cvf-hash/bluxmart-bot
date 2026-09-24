import { Vec3 } from 'vec3'

/**
 * Blocks that immediately disqualify a delivery drop within 5 blocks.
 * Specifically targets lava, flowing lava, campfires, fire, and damage blocks.
 */
export const DANGEROUS_BLOCKS = new Set([
  'lava',
  'flowing_lava',
  'campfire',
  'soul_campfire',
  'fire',
  'soul_fire',
  'lava_cauldron',
  'magma_block',
  'cactus',
  'wither_rose'
])

/**
 * Scans a 3D cubic volume around a center position (default radius = 5 blocks)
 * and also around the buyer's position (if visible) for lava or campfires.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {number} radius - Block radius to check (default 5)
 * @param {string} [buyerUsername] - Optional buyer IGN to also check around their feet
 * @returns {{ safe: boolean, hazard: null | { name: string, position: { x: number, y: number, z: number }, distance: number, centerType: string } }}
 */
export function checkAreaSafety(bot, radius = 5, buyerUsername = null) {
  if (!bot?.entity?.position) {
    return { safe: false, hazard: { name: 'bot_not_spawned', position: { x: 0, y: 0, z: 0 }, distance: 0, centerType: 'bot' } }
  }

  const centers = [{ pos: bot.entity.position, label: 'bot' }]

  if (buyerUsername && bot.players?.[buyerUsername]?.entity?.position) {
    centers.push({
      pos: bot.players[buyerUsername].entity.position,
      label: `buyer:${buyerUsername}`
    })
  }

  for (const center of centers) {
    const base = center.pos.floored()
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const checkPos = base.offset(dx, dy, dz)
          // Euclidean distance check <= radius (or Chebyshev within radius cube)
          const euclideanDist = center.pos.distanceTo(
            new Vec3(checkPos.x + 0.5, checkPos.y + 0.5, checkPos.z + 0.5)
          )
          if (euclideanDist > radius + 0.75) continue

          const block = bot.blockAt(checkPos)
          if (!block || !block.name) continue

          const blockName = block.name.toLowerCase()
          if (
            DANGEROUS_BLOCKS.has(blockName) ||
            blockName.includes('lava') ||
            blockName.includes('campfire')
          ) {
            return {
              safe: false,
              hazard: {
                name: block.name,
                position: { x: checkPos.x, y: checkPos.y, z: checkPos.z },
                distance: Number(euclideanDist.toFixed(2)),
                centerType: center.label
              }
            }
          }
        }
      }
    }
  }

  return { safe: true, hazard: null }
}
