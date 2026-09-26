import { Vec3 } from 'vec3'

/**
 * Blocks that immediately disqualify a delivery drop within the safety radius.
 * Targets lava, fire, campfires, explosives, and movement/damage traps.
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
  'wither_rose',
  'tnt',
  'respawn_anchor',
  'end_portal',
  'sweet_berry_bush',
  'cobweb',
  'pointed_dripstone',
  'nether_portal',
  'powder_snow',
  'hopper',
  'piston',
  'sticky_piston',
  'moving_piston',
  'dispenser',
  'dropper',
  'sculk_shrieker'
])

export const HOSTILE_MOBS = new Set([
  'creeper',
  'zombie',
  'skeleton',
  'spider',
  'cave_spider',
  'witch',
  'vindicator',
  'evoker',
  'ravager',
  'vex',
  'pillager',
  'warden',
  'wither',
  'wither_skeleton',
  'blaze',
  'ghast',
  'piglin_brute',
  'hoglin',
  'zoglin',
  'shulker',
  'phantom',
  'drowned',
  'husk',
  'stray'
])

export const WEAPON_KEYWORDS = [
  'sword',
  'axe',
  'bow',
  'crossbow',
  'crystal',
  'tnt',
  'anchor',
  'mace'
]

const NON_SOLID_FOOTING_BLOCKS = new Set([
  'air',
  'void_air',
  'cave_air',
  'water',
  'flowing_water',
  'lava',
  'flowing_lava',
  'powder_snow',
  'cobweb'
])

/**
 * Scans a 3D volume around center positions (bot and buyer) for:
 * 1. Static hazards (lava, fire, campfires, cacti, explosives, portals, hoppers, pistons).
 * 2. Void / fall trap hazards (lack of solid footing within 1..4 blocks under feet at ANY Y-level).
 * 3. Hostile mobs & armed players (including buyer) within 8 blocks (PvP trap guard).
 *
 * @param {import('mineflayer').Bot} bot
 * @param {number} radius - Block radius to check (default 5)
 * @param {string} [buyerUsername] - Optional buyer IGN
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

  // 1. Check solid ground footing beneath bot's feet across ALL Y-levels (dy = 1..4)
  if (typeof bot.blockAt === 'function') {
    let hasSolidGround = false
    for (let dy = 1; dy <= 4; dy++) {
      const groundBlock = bot.blockAt(bot.entity.position.offset(0, -dy, 0))
      const blockName = groundBlock?.name?.toLowerCase() || ''
      if (
        groundBlock &&
        blockName &&
        !NON_SOLID_FOOTING_BLOCKS.has(blockName) &&
        groundBlock.boundingBox !== 'empty'
      ) {
        hasSolidGround = true
        break
      }
    }

    if (!hasSolidGround) {
      return {
        safe: false,
        hazard: {
          name: 'void_or_pit_drop',
          position: { x: bot.entity.position.x, y: bot.entity.position.y - 1, z: bot.entity.position.z },
          distance: 1,
          centerType: 'bot'
        }
      }
    }
  }

  // 2. Scan block hazards around bot and buyer
  if (typeof bot.blockAt === 'function') {
    for (const center of centers) {
      const base = center.pos.floored()
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dz = -radius; dz <= radius; dz++) {
            const checkPos = base.offset(dx, dy, dz)
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
  }

  // 3. Check for nearby hostile mobs & armed players (including buyerUser) within 8 blocks
  if (bot.entities) {
    const botUser = (bot._client?.username || bot.username || '').toLowerCase()

    for (const entity of Object.values(bot.entities)) {
      if (!entity || !entity.position || entity === bot.entity) continue

      const dist = bot.entity.position.distanceTo(entity.position)
      if (dist > 8.0) continue

      const entityName = (entity.name || entity.mobType || '').toLowerCase()

      // Check for dangerous entities within 5 blocks
      if (
        dist <= 5.0 &&
        (entity.name === 'end_crystal' ||
          entity.name === 'hopper_minecart' ||
          entity.name === 'tnt' ||
          entityName === 'end_crystal' ||
          entityName === 'hopper_minecart' ||
          entityName === 'tnt')
      ) {
        return {
          safe: false,
          hazard: {
            name: entity.name || entityName,
            position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
            distance: Number(dist.toFixed(2)),
            centerType: 'dangerous_entity'
          }
        }
      }

      if (HOSTILE_MOBS.has(entityName)) {
        return {
          safe: false,
          hazard: {
            name: `hostile_mob (${entityName})`,
            position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
            distance: Number(dist.toFixed(2)),
            centerType: 'hostile_mob'
          }
        }
      }

      if (entity.type === 'player') {
        const entityUsername = (entity.username || '').toLowerCase()
        if (!entityUsername || entityUsername === botUser) continue

        // Check if holding a weapon or offensive item (checks ALL players including buyerUser)
        const heldItem = entity.heldItem?.name?.toLowerCase() || ''
        const isArmed = WEAPON_KEYWORDS.some((kw) => heldItem.includes(kw))
        if (isArmed) {
          return {
            safe: false,
            hazard: {
              name: `armed_hostile_player (${entity.username} holding ${heldItem})`,
              position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
              distance: Number(dist.toFixed(2)),
              centerType: 'hostile_player'
            }
          }
        }
      }
    }
  }

  return { safe: true, hazard: null }
}
