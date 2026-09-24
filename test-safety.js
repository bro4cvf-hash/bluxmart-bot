import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { checkAreaSafety } from './safety.js'

function createMockBot(blocksMap = {}, botPos = new Vec3(100, 64, 100), buyerPos = null) {
  return {
    entity: { position: botPos },
    players: buyerPos
      ? {
          TestBuyer: {
            entity: { position: buyerPos }
          }
        }
      : {},
    blockAt(pos) {
      const key = `${pos.x},${pos.y},${pos.z}`
      return { name: blocksMap[key] || 'air' }
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

console.log('✅ All 5-block Lava & Campfire safety checks passed!')
