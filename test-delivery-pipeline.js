import assert from 'node:assert/strict'
import EventEmitter from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { Vec3 } from 'vec3'
import { DeliveryQueueManager, isPlayerOnline } from './deliveryQueue.js'

const TEST_QUEUE_FILE = path.resolve('./test-delivery-queue.json')
const TEST_BAK_FILE = `${TEST_QUEUE_FILE}.bak`
const TEST_TOMBSTONE_FILE = `${TEST_QUEUE_FILE}.tombstones.json`

function cleanupTestFiles() {
  if (fs.existsSync(TEST_QUEUE_FILE)) fs.unlinkSync(TEST_QUEUE_FILE)
  if (fs.existsSync(TEST_BAK_FILE)) fs.unlinkSync(TEST_BAK_FILE)
  if (fs.existsSync(TEST_TOMBSTONE_FILE)) fs.unlinkSync(TEST_TOMBSTONE_FILE)
}
cleanupTestFiles()

async function waitForIdle(manager, timeoutMs = 15000) {
  const start = Date.now()
  await new Promise((r) => setTimeout(r, 150))
  while (manager.processing) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for manager to become idle (processing = ${manager.processing})`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

function createMockBot(opts = {}) {
  const emitter = new EventEmitter()
  const chatMessages = []
  const tossedItems = []
  let pos = opts.initialPos ? opts.initialPos.clone() : new Vec3(0, 64, 0)

  return {
    _client: { username: opts.username || 'TrafficerBot' },
    username: opts.username || 'TrafficerBot',
    entity: {
      position: pos,
      yaw: 0,
      pitch: 0
    },
    players: opts.players !== undefined ? opts.players : {
      TestPlayer: {
        entity: { position: new Vec3(100, 64, 100) }
      }
    },
    entities: opts.entities || {},
    on: (evt, fn) => emitter.on(evt, fn),
    removeListener: (evt, fn) => emitter.removeListener(evt, fn),
    off: (evt, fn) => emitter.off(evt, fn),
    emit: (evt, ...args) => emitter.emit(evt, ...args),
    async tabComplete(text, assumeCommand = false, sendBlockInSight = false, timeout = 3500) {
      if (typeof opts.tabComplete === 'function') {
        return opts.tabComplete(text, assumeCommand, sendBlockInSight, timeout)
      }
      if (text.startsWith('/tpa ')) {
        const query = text.slice(5).trim().toLowerCase()
        const matched = []
        for (const p of Object.keys(this.players || {})) {
          if (p.toLowerCase().startsWith(query)) {
            matched.push(p)
          }
        }
        return matched
      }
      return []
    },
    inventory: {
      items: () => opts.inventoryItems || [
        { name: 'spawner', type: 52, count: 64 },
        { name: 'elytra', type: 443, count: 1 }
      ],
      emptySlotCount: () => (opts.emptySlots !== undefined ? opts.emptySlots : 10)
    },
    chat(msg) {
      chatMessages.push(msg)
      if (typeof opts.onChatHook === 'function') {
        opts.onChatHook(msg, this, emitter)
      }
      if (msg.startsWith('/tpa')) {
        if (opts.simulateTeleport !== false) {
          const targetName = msg.split(' ')[1]
          const targetPos = this.players[targetName]?.entity?.position
          if (targetPos) {
            this.entity.position = targetPos.offset(1, 0, 1)
          } else {
            this.entity.position = new Vec3(100, 64, 100)
          }
        }
      } else if (msg.startsWith('/home 1') || msg.startsWith('/home')) {
        // simulate returning home to base
        this.entity.position = (opts.initialPos || new Vec3(0, 64, 0)).clone()
      }
    },
    lookAt: async (point, force) => {},
    look: async (yaw, pitch, force) => {},
    setControlState: (control, state) => {},
    toss: async (type, metadata, count) => {
      tossedItems.push({ type, count })
      if (opts.throwOnToss) {
        throw new Error('Simulated network disconnect during toss')
      }
    },
    findBlock: () => ({ position: new Vec3(1, 64, 1), name: 'ender_chest' }),
    openContainer: async (block, direction, cursorPos) => ({
      containerItems: () => opts.containerItems || [
        { name: 'spawner', type: 52, count: 64 },
        { name: 'elytra', type: 443, count: 1 }
      ],
      withdraw: async () => {},
      deposit: async () => {},
      close: () => {}
    }),
    blockAt: (p) => {
      const hazard = opts.hazards?.[`${p.x},${p.y},${p.z}`]
      if (hazard) return { name: hazard }
      // Default: ground below y=64 is stone
      if (p.y <= 63) return { name: 'stone' }
      return { name: 'air' }
    },
    _getChats: () => chatMessages,
    _getTossed: () => tossedItems
  }
}

async function runTests() {
  console.log('🧪 Starting Delivery Pipeline Unit & Integration Tests (Doubt-Driven Architecture)...\n')

  let botInstance = createMockBot()
  const updatesReceived = []

  let manager = new DeliveryQueueManager(() => botInstance, {
    queueFilePath: TEST_QUEUE_FILE,
    safetyRadius: 5,
    tpaTimeoutMs: 1500,
    maxRetries: 3,
    safeReturnCommand: '/home 1',
    onStatusChange: (order, extra) => {
      updatesReceived.push({ id: order.orderId || order.id, status: order.status, extra })
    }
  })

  // Test 1: Interoperability Schema (Legacy vs Modern)
  console.log('--- Test 1: Schema Interoperability ---')
  const q1 = manager.enqueue({
    id: 'ord_legacy_1',
    recipient: 'TestPlayer',
    money: 500000
  })
  assert.equal(q1.status, 'queued')
  assert.equal(q1.order.orderId, 'ord_legacy_1')
  assert.equal(q1.order.minecraftUsername, 'TestPlayer')
  assert.equal(q1.order.moneyAmount, 500000)
  console.log('✅ Test 1: Legacy schema ({ id, recipient, money }) successfully mapped.\n')

  // Test 2: Deduplication
  console.log('--- Test 2: Deduplication ---')
  const q1Dupe = manager.enqueue({
    orderId: 'ord_legacy_1',
    minecraftUsername: 'TestPlayer',
    moneyAmount: 500000
  })
  assert.equal(q1Dupe.status, 'already_queued')
  assert.equal(manager.queue.length, 1)
  console.log('✅ Test 2: Deduplication prevents duplicate orders on repeated webhooks/polls.\n')

  // Test 3: Money Delivery (Offline Capable)
  console.log('--- Test 3: Offline Money Delivery ---')
  await waitForIdle(manager)
  const chats = botInstance._getChats()
  assert.ok(chats.some((c) => c.includes('/pay TestPlayer 500000')), 'Bot should send /pay command')
  const completedOrder = manager.queue.find((o) => o.orderId === 'ord_legacy_1')
  assert.equal(completedOrder.status, 'completed')
  assert.equal(completedOrder.moneyDelivered, true)
  console.log('✅ Test 3: Offline Money order automatically delivered via /pay and marked complete.\n')

  // Test 4: Physical Item Delivery (Safe Area)
  console.log('--- Test 4: Physical Item Delivery ---')
  botInstance = createMockBot({ initialPos: new Vec3(0, 64, 0) })
  const q2 = manager.enqueue({
    orderId: 'ord_items_safe',
    minecraftUsername: 'TestPlayer',
    spawners: 2,
    elytras: 1
  })
  assert.equal(q2.status, 'queued')

  await waitForIdle(manager)
  const q2Chats = botInstance._getChats()
  assert.ok(q2Chats.some((c) => c.includes('/tpa TestPlayer')), 'Bot should send /tpa')
  assert.ok(q2Chats.some((c) => c.includes('/home 1') || c.includes('/home')), 'Bot should return /home 1')
  const itemOrder = manager.queue.find((o) => o.orderId === 'ord_items_safe')
  assert.equal(itemOrder.status, 'completed')
  assert.equal(itemOrder.itemsDelivered, true)
  console.log('✅ Test 4: Physical items (Spawners & Elytras) safely delivered via Ender Chest + TPA.\n')

  // Test 5: Safety Abort on Lava Hazard
  console.log('--- Test 5: Safety Abort on Hazard ---')
  const lavaHazards = {
    '102,64,100': 'lava' // within 5 blocks of player
  }
  botInstance = createMockBot({ initialPos: new Vec3(0, 64, 0), hazards: lavaHazards })
  const q3 = manager.enqueue({
    orderId: 'ord_unsafe',
    minecraftUsername: 'TestPlayer',
    spawners: 1
  })

  await waitForIdle(manager)
  const q3Chats = botInstance._getChats()
  assert.ok(q3Chats.some((c) => c.includes('DELIVERY ABORTED')), 'Bot should abort delivery on hazard')
  const unsafeOrder = manager.queue.find((o) => o.orderId === 'ord_unsafe')
  assert.equal(unsafeOrder.status, 'waiting_for_player')
  assert.ok(unsafeOrder.lastError.includes('lava'), 'Error should mention lava hazard')
  console.log('✅ Test 5: Lava hazard within 5 blocks triggers safety abort and returns items.\n')

  // Test 6: Multi-Order Whisper Claim
  console.log('--- Test 6: Multi-Order Claim Re-queue ---')
  // Add a second waiting order for TestPlayer
  const q4 = manager.enqueue({
    orderId: 'ord_unsafe_2',
    minecraftUsername: 'TestPlayer',
    spawners: 2
  })
  q4.order.status = 'waiting_for_player'
  unsafeOrder.status = 'waiting_for_player'
  manager.saveQueue()

  const retried = manager.retryPendingForPlayer('TestPlayer')
  assert.equal(retried, true)
  assert.equal(unsafeOrder.status, 'pending', 'First order should be pending')
  assert.equal(q4.order.status, 'pending', 'Second order should also be re-queued to pending!')

  // Mark TestPlayer orders completed so they do not conflict with subsequent tests
  unsafeOrder.status = 'completed'
  q4.order.status = 'completed'
  manager.saveQueue()
  await waitForIdle(manager)
  console.log('✅ Test 6: In-game whisper "claim" successfully re-queued ALL pending orders for player.\n')

  // Test 7: Head-of-Line Starvation Prevention (Offline Player Bypass)
  console.log('--- Test 7: Anti-Head-of-Line (Offline Bypass) ---')
  // Bot with only OnlineBuyer in players list; OfflineBuyer is NOT online
  botInstance = createMockBot({
    initialPos: new Vec3(0, 64, 0),
    players: {
      OnlineBuyer: { entity: { position: new Vec3(200, 64, 200) } }
    }
  })

  // Enqueue offline buyer FIRST, then online buyer SECOND
  manager.enqueue({
    orderId: 'ord_offline_buyer',
    minecraftUsername: 'OfflineBuyer',
    spawners: 1
  })
  manager.enqueue({
    orderId: 'ord_online_buyer',
    minecraftUsername: 'OnlineBuyer',
    spawners: 1
  })

  await waitForIdle(manager)
  const offlineOrd = manager.queue.find((o) => o.orderId === 'ord_offline_buyer')
  const onlineOrd = manager.queue.find((o) => o.orderId === 'ord_online_buyer')

  assert.equal(onlineOrd.status, 'completed', 'Online buyer order should complete immediately')
  assert.equal(offlineOrd.status, 'waiting_for_player', 'Offline buyer should be gracefully deferred')
  console.log('✅ Test 7: Offline buyer does NOT block online buyer (0 starvation).\n')

  // Test 8: Real-Time Toss Accounting (Anti-Duplication)
  console.log('--- Test 8: Anti-Duplication Real-Time Toss Decrementing ---')
  botInstance = createMockBot({
    initialPos: new Vec3(51, 64, 50),
    players: {
      DupTarget: { entity: { position: new Vec3(50, 64, 50) } }
    },
    // Split into 2 stacks of spawners
    inventoryItems: [
      { name: 'spawner', type: 52, count: 2 },
      { name: 'spawner', type: 52, count: 3 }
    ]
  })

  const dupOrder = {
    orderId: 'ord_dup_test',
    minecraftUsername: 'DupTarget',
    spawners: 5,
    elytras: 0
  }
  manager.queue.push(dupOrder)
  manager.saveQueue()

  // First stack of 2 tosses successfully, second stack throws interruption
  let callCount = 0
  botInstance.toss = async (type, meta, count) => {
    callCount++
    if (callCount > 1) {
      throw new Error('Player moved out of reach')
    }
  }

  try {
    await manager.tossOrderedItemsSafely(botInstance, 'DupTarget', dupOrder)
  } catch (err) {
    // Expected interruption
  }

  // The order on disk should have spawners reduced from 5 to 3
  const savedQueue = manager.loadQueue()
  const foundSaved = savedQueue.find((o) => o.orderId === 'ord_dup_test')
  assert.equal(foundSaved.spawners, 3, 'Spawners count must be exactly 3 after tossing 2')
  console.log(`✅ Test 8: Anti-duplication confirmed: quantity decremented on disk (5 -> ${foundSaved.spawners}) before interruption.\n`)

  // Test 9: Atomic Save & Backup Auto-Recovery (.bak)
  console.log('--- Test 9: Atomic Save & Backup Auto-Recovery ---')
  assert.ok(fs.existsSync(TEST_BAK_FILE), 'Backup .bak file should exist from atomic save')
  // Corrupt primary file
  fs.writeFileSync(TEST_QUEUE_FILE, '{ corrupted_json...', 'utf8')

  // Loading queue should automatically recover from .bak
  const recoveredQueue = manager.loadQueue()
  assert.ok(recoveredQueue.length > 0, 'Queue should recover from backup file')
  console.log(`✅ Test 9: Self-healing backup recovered ${recoveredQueue.length} orders after primary file corruption.\n`)

  // Test 10: Command Injection Security
  console.log('--- Test 10: Security Command Injection Guard ---')
  assert.throws(
    () => manager.enqueue({ orderId: 'ord_hack_1', minecraftUsername: 'Attacker 999999999', moneyAmount: 1000 }),
    /Invalid Minecraft username/,
    'Should reject space-injected /pay argument attack'
  )
  assert.throws(
    () => manager.enqueue({ orderId: 'ord_hack_2', minecraftUsername: 'Attacker\n/op Attacker', moneyAmount: 1000 }),
    /Invalid Minecraft username/,
    'Should reject newline command injection attack'
  )
  console.log('✅ Test 10: Security guard blocked Minecraft /pay argument & newline injection attacks.\n')

  // Test 11: Tab Complete Online Verification (/tpa prefix)
  console.log('--- Test 11: Tab Complete Online Verification (/tpa prefix) ---')
  const tabMockBot = createMockBot({
    players: {
      DrDonrtt: { entity: { position: new Vec3(100, 64, 100) } }
    }
  })
  const isDrDonrttOnline = await isPlayerOnline(tabMockBot, 'DrDonrtt')
  assert.equal(isDrDonrttOnline, true, 'DrDonrtt should be detected as online via /tpa drdonrt prefix tab completion')

  const isCaseInsensitiveOnline = await isPlayerOnline(tabMockBot, 'drdonrtt')
  assert.equal(isCaseInsensitiveOnline, true, 'Tab completion matching must be case-insensitive')

  const isGhostOnline = await isPlayerOnline(tabMockBot, 'GhostPlayer')
  assert.equal(isGhostOnline, false, 'GhostPlayer without tab suggestions must return false (offline)')
  console.log('✅ Test 11: Tab complete (/tpa prefix) online check successfully verified.\n')

  // Test 12: Chat "This user is not online" Catch & Safe Ender Chest Rollback
  console.log('--- Test 12: Chat "This user is not online" Catch & Safe Ender Chest Rollback ---')
  let depositedBack = false
  const chatOfflineBot = createMockBot({
    players: {
      GhostBuyer: { entity: { position: new Vec3(100, 64, 100) } }
    },
    simulateTeleport: false,
    onChatHook(msg, bot, emitter) {
      if (msg.startsWith('/tpa GhostBuyer')) {
        // Emit in-game chat error when TPA is sent
        setImmediate(() => {
          emitter.emit('messagestr', 'This user is not online')
        })
      }
    }
  })
  chatOfflineBot.openContainer = async () => ({
    containerItems: () => [
      { name: 'spawner', type: 52, count: 64 },
      { name: 'elytra', type: 443, count: 1 }
    ],
    withdraw: async () => {},
    deposit: async () => {
      depositedBack = true
    },
    close: () => {}
  })

  const chatTestManager = new DeliveryQueueManager(() => chatOfflineBot, {
    queueFilePath: TEST_QUEUE_FILE,
    tpaTimeoutMs: 3000
  })

  await chatTestManager.enqueue({
    orderId: 'ord_chat_offline',
    minecraftUsername: 'GhostBuyer',
    spawners: 2,
    elytras: 0
  })

  await waitForIdle(chatTestManager, 10000)

  const offlineOrder = chatTestManager.queue.find((o) => o.orderId === 'ord_chat_offline')
  assert.equal(offlineOrder.status, 'waiting_for_player', 'Order should transition to waiting_for_player on chat offline detection')
  assert.ok(
    offlineOrder.lastError && offlineOrder.lastError.includes('This user is not online'),
    `lastError should capture chat message, got: ${offlineOrder.lastError}`
  )
  assert.equal(depositedBack, true, 'Items must be deposited back into Ender Chest on chat offline abort')
  console.log('✅ Test 12: Server chat "This user is not online" successfully caught, TPA canceled, items returned to Ender Chest.\n')

  // Cleanup
  cleanupTestFiles()

  console.log('🎉 ALL 12 Architectural Resilience Tests Passed Successfully (100% Green)!')
  process.exit(0)
}

runTests().catch((err) => {
  console.error('❌ Pipeline test failed:', err)
  cleanupTestFiles()
  process.exit(1)
})
