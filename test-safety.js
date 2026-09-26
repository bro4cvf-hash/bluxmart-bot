import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { checkAreaSafety } from './safety.js'

function createMockBot(blocksMap = {}, botPos = new Vec3(100, 64, 100), buyerPos = null, entities = {}) {
  return {
    entity: { position: botPos },
    entities,
    players: buyerPos
      ? {
          TestBuyer: {
            entity: { position: buyerPos }
          }
        }
      : {},
    blockAt(pos) {
      const key = `${pos.x},${pos.y},${pos.z}`
      if (Object.prototype.hasOwnProperty.call(blocksMap, key)) {
        return { name: blocksMap[key] }
      }
      if (pos.y === 63) {
        return { name: 'stone' }
      }
      return { name: 'air' }
    }
  }
}

// 1. Clean area -> safe = true
{
  const bot = createMockBot()
  const res = checkAreaSafety(bot, 5, 'TestBuyer')
  assert.equal(res.safe, true)
  assert.equal(res.hazard, null)
}

// 2. Lava at 3 blocks away -> safe = false
{
  const bot = createMockBot({ '103,64,100': 'lava' })
  const res = checkAreaSafety(bot, 5)
  assert.equal(res.safe, false)
  assert.equal(res.hazard.name, 'lava')
  assert.ok(res.hazard.distance <= 5)
}

// 3. Campfire at 4 blocks away -> safe = false
{
  const bot = createMockBot({ '100,64,104': 'campfire' })
  const res = checkAreaSafety(bot, 5)
  assert.equal(res.safe, false)
  assert.equal(res.hazard.name, 'campfire')
}

// 4. Soul Campfire near buyer (within 5 blocks of buyer) -> safe = false
{
  const bot = createMockBot(
    { '122,64,100': 'soul_campfire' },
    new Vec3(100, 64, 100),
    new Vec3(120, 64, 100)
  )
  const res = checkAreaSafety(bot, 5, 'TestBuyer')
  assert.equal(res.safe, false)
  assert.equal(res.hazard.name, 'soul_campfire')
  assert.equal(res.hazard.centerType, 'buyer:TestBuyer')
}

// 5. Lava at 7 blocks away (> 5 blocks) -> safe = true
{
  const bot = createMockBot({ '107,64,100': 'lava' })
  const res = checkAreaSafety(bot, 5)
  assert.equal(res.safe, true)
}

// 6. Pit trap / air beneath bot's feet -> safe = false
{
  const bot = createMockBot({
    '100,63,100': 'air',
    '100,62,100': 'air',
    '100,61,100': 'air',
    '100,60,100': 'air'
  })
  const res = checkAreaSafety(bot, 5)
  assert.equal(res.safe, false)
  assert.equal(res.hazard.name, 'void_or_pit_drop')
}

// 7. Hopper item-theft trap near drop zone -> safe = false
{
  const bot = createMockBot({ '101,63,100': 'hopper' })
  const res = checkAreaSafety(bot, 5)
  assert.equal(res.safe, false)
  assert.equal(res.hazard.name, 'hopper')
}

// 8. Armed buyer holding a weapon -> safe = false
{
  const botPos = new Vec3(100, 64, 100)
  const buyerPos = new Vec3(102, 64, 100)
  const bot = createMockBot({}, botPos, buyerPos, {
    1: {
      type: 'player',
      username: 'TestBuyer',
      position: buyerPos,
      heldItem: { name: 'netherite_sword' }
    }
  })
  const res = checkAreaSafety(bot, 5, 'TestBuyer')
  assert.equal(res.safe, false)
  assert.ok(res.hazard.name.includes('armed_hostile_player'))
}

// 9. Hostile mob (creeper) within 8 blocks -> safe = false
{
  const botPos = new Vec3(100, 64, 100)
  const bot = createMockBot({}, botPos, null, {
    2: {
      type: 'mob',
      name: 'creeper',
      position: new Vec3(104, 64, 100)
    }
  })
  const res = checkAreaSafety(bot, 5)
  assert.equal(res.safe, false)
  assert.ok(res.hazard.name.includes('hostile_mob'))
}

console.log('✅ All 9 safety checks (Lava, Campfire, Pit Traps, Hoppers, Armed Buyer, Hostile Mobs) passed!')
