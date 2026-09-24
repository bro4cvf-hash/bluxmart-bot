import { createRequire } from 'module'
const require = createRequire(import.meta.url)

let customSender = null
export function setRendererSender(fn) {
  customSender = fn
}

function sendToRenderer(channel, ...args) {
  if (customSender) {
    customSender(channel, ...args)
    return
  }
  try {
    const { BrowserWindow } = require('electron')
    const win = BrowserWindow?.getAllWindows?.()?.[0]
    win?.webContents?.send(channel, ...args)
  } catch {
    // Running headless / web mode
  }
}

export function salt(length) {
  var result = ''
  var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (var i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length))
  }
  return result
}

export function delay(ms) {
  return new Promise((res) => setTimeout(res, ms))
}

export function botMode(mode) {
  switch (mode) {
    case 'minimal':
      return {
        physicsEnabled: false,
        viewDistance: 'tiny',
        plugins: {
          anvil: false,
          block_actions: false,
          blocks: false,
          book: false,
          boss_bar: false,
          breath: false,
          chest: false,
          command_block: false,
          conversions: false,
          craft: false,
          creative: false,
          digging: false,
          enchantment_table: false,
          entities: false,
          experience: false,
          explosion: false,
          fishing: false,
          furnace: false,
          generic_place: false,
          health: false,
          inventory: false,
          loader: false,
          painting: false,
          particle: false,
          place_block: false,
          place_entity: false,
          physics: false,
          rain: false,
          ray_trace: false,
          resource_pack: false,
          scoreboard: false,
          simple_inventory: false,
          sound: false,
          spawn_point: false,
          tablist: false,
          team: false,
          time: false,
          title: false,
          villager: false
        }
      }
    default:
      return
  }
}

export function genName() {
  const adjectives = [
    'Red',
    'Hot',
    'Big',
    'Old',
    'New',
    'Dry',
    'Wet',
    'Tall',
    'Soft',
    'Loud',
    'Cold',
    'Warm',
    'Dark',
    'Fair',
    'Blue',
    'Gray',
    'Rich',
    'Poor',
    'Fast',
    'Slow',
    'Thin',
    'Tiny',
    'Wide',
    'High',
    'Deep',
    'Dear',
    'Neat',
    'Cool',
    'Fine',
    'Lame',
    'Sharp',
    'Dull',
    'Cute',
    'Long',
    'Short',
    'Hard',
    'Mean',
    'Kind',
    'Sick',
    'Weak',
    'Pure',
    'Evil',
    'Bold',
    'Mild',
    'Wild',
    'Mad',
    'Calm',
    'Wise',
    'Dumb',
    'Slim',
    'Thick',
    'Pale',
    'Stale',
    'Ugly'
  ]
  const nouns = [
    '_',
    'Dog',
    'Cat',
    'Pen',
    'Car',
    'Cup',
    'Hat',
    'Sun',
    'Bed',
    'Box',
    'Key',
    'Arm',
    'Ball',
    'Book',
    'Cake',
    'Duck',
    'Fish',
    'Fork',
    'Hand',
    'Bird',
    'Moon',
    'Star',
    'Tree',
    'Ring',
    'Shoe',
    'Bear',
    'Coat',
    'Flag',
    'Lamp',
    'Leaf',
    'Desk',
    'Nail',
    'Sock',
    'Rose',
    'Boat',
    'Frog',
    'Pipe',
    'Rock',
    'Seal',
    'Boot',
    'Worm',
    'Bat',
    'Bell',
    'Belt',
    'Door',
    'Drum',
    'Gate',
    'Hair',
    'Head',
    'Heart',
    'Kiss',
    'Lady',
    'Lark',
    'Lion',
    'Bowl',
    'Deer',
    'Goat',
    'Nose',
    'Bone',
    'Bull',
    'Food',
    'Gown',
    'Gulf',
    'Horn',
    'Joke',
    'Jute',
    'Milk',
    'Mole',
    'Navy',
    'Pony',
    'Queen',
    'Rope',
    'Ruff',
    'Shin',
    'Tong',
    'Light',
    'Trot',
    'Vase',
    'Wren',
    'Yoke',
    'Zulu'
  ]
  const adjectivesLength = adjectives.length
  const nounsLength = nouns.length
  let name = ''

  while (name.length < 6 || name.length + 1 > 16) {
    const adjectiveIndex = Math.floor(Math.random() * adjectivesLength)
    const nounIndex = Math.floor(Math.random() * nounsLength)
    const newName = `${adjectives[adjectiveIndex]}${nouns[nounIndex]}`

    if (newName.length + name.length > 16) {
      break
    }

    name += newName

    if (Math.random() < 0.15) {
      const num = Math.floor(Math.random() * 999 + 1)
      if (name.length + num.toString().length > 16) {
        break
      }
      name += num
    }
  }

  const lowerCaseName = name.toLowerCase()
  const hasLowerCase = name !== lowerCaseName
  name += hasLowerCase ? lowerCaseName.slice(0, 16 - name.length) : ''

  return name
}

export function sendEvent(username, event, message) {
  const info = {
    id: username,
    event: event,
    message: message
  }
  sendToRenderer('botEvent', info)
}

export function proxyEvent(proxy, event, message, count) {
  const info = {
    proxy: proxy,
    event: event,
    message: message,
    count: count
  }
  sendToRenderer('proxyEvent', info)
}

export function notify(title, body, type, img, keep) {
  sendToRenderer('notify', title, body, type, img, keep)
}

// Converts a chat/text component value into clean, color-code-free plain
// text. Minecraft has represented text components in a few different shapes
// depending on version/context, all of which show up in this codebase:
//  - A plain string (rare, already-flattened text).
//  - A JSON-encoded chat component string (legacy NBT string tags, e.g.
//    pre-1.20.5 item lore).
//  - An NBT-encoded text component tree ({ type, value } - used by 1.20.5+
//    "data component" servers for things like item lore and window titles),
//    which needs prismarine-nbt's `simplify` helper instead of `JSON.parse`.
//  - An already-simplified plain object ({ text, extra, ... }).
export function flattenTextComponent(value) {
  if (value == null) return ''
  if (typeof value === 'string') {
    try {
      return cleanText(JSON.parse(value))
    } catch {
      return value.replace(/§./g, '')
    }
  }
  if (typeof value === 'object') {
    if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
      const rendered = value.toString()
      if (rendered && rendered !== '[object Object]') return rendered.replace(/Â§./g, '')
    }
    if ('type' in value && 'value' in value) {
      try {
        const nbtModule = require('prismarine-nbt')
        return cleanText(nbtModule.simplify(value))
      } catch {
        return ''
      }
    }
    return cleanText(value)
  }
  return ''
}

// Reads an item's lore (used by shops/auction plugins to show price/description
// text, e.g. "$ 7.1K") and returns clean, color-code-free lines of text.
// `item.customLore` (from prismarine-item) already normalizes the legacy
// (NBT `display.Lore`) and 1.20.5+ (data component) lore formats for us.
export function extractLore(item) {
  try {
    const loreEntries = item?.customLore
    if (!Array.isArray(loreEntries)) return []
    return loreEntries.map(flattenTextComponent).filter(Boolean)
  } catch {
    return []
  }
}

// Human-friendly names for vanilla window types, used as a fallback when the
// server doesn't send a usable title so the viewer shows "Chest" instead of
// the raw internal id ("minecraft:generic_9x6").
const WINDOW_TYPE_NAMES = {
  'minecraft:inventory': 'Inventory',
  'minecraft:generic_9x1': 'Container',
  'minecraft:generic_9x2': 'Container',
  'minecraft:generic_9x3': 'Chest',
  'minecraft:generic_9x4': 'Container',
  'minecraft:generic_9x5': 'Container',
  'minecraft:generic_9x6': 'Large Chest',
  'minecraft:generic_3x3': 'Dispenser',
  'minecraft:crafter_3x3': 'Crafter',
  'minecraft:anvil': 'Anvil',
  'minecraft:beacon': 'Beacon',
  'minecraft:blast_furnace': 'Blast Furnace',
  'minecraft:brewing_stand': 'Brewing Stand',
  'minecraft:crafting': 'Crafting Table',
  'minecraft:crafting_table': 'Crafting Table',
  'minecraft:enchantment': 'Enchanting Table',
  'minecraft:enchanting_table': 'Enchanting Table',
  'minecraft:furnace': 'Furnace',
  'minecraft:grindstone': 'Grindstone',
  'minecraft:hopper': 'Hopper',
  'minecraft:lectern': 'Lectern',
  'minecraft:loom': 'Loom',
  'minecraft:merchant': 'Villager Trade',
  'minecraft:villager': 'Villager Trade',
  'minecraft:shulker_box': 'Shulker Box',
  'minecraft:smithing': 'Smithing Table',
  'minecraft:smoker': 'Smoker',
  'minecraft:cartography': 'Cartography Table',
  'minecraft:stonecutter': 'Stonecutter',
  'minecraft:dispenser': 'Dispenser',
  'minecraft:dropper': 'Dropper'
}

// Resolves a window's display name: flattens the server-sent title (which,
// on 1.20.5+ servers, is an NBT text component tree rather than plain text),
// falling back to a friendly name derived from the window type if the title
// is missing/empty.
export function friendlyWindowTitle(title, type) {
  const text = flattenTextComponent(title).trim()
  if (text) return text
  if (typeof type === 'string') {
    return WINDOW_TYPE_NAMES[type] || type.replace('minecraft:', '').replaceAll('_', ' ')
  }
  return 'Open container'
}

export function cleanText(component) {
  let texts = []

  function recurse(obj) {
    if (obj == null) return
    // Some text components are bare primitives (a plain string, or an NBT
    // string tag simplified straight down to a JS string) rather than an
    // object with a `.text` field - e.g. an unstyled title like
    // "Auction (Page 1)" sent as a primitive NBT string component.
    if (typeof obj === 'string') {
      texts.push(obj.replace(/\n/g, ' '))
      return
    }
    if (Array.isArray(obj)) {
      for (const item of obj) recurse(item)
      return
    }
    if (obj.text) {
      texts.push(obj.text.replace(/\n/g, ' '))
    }
    if (obj.translate) {
      texts.push(String(obj.translate))
    }
    if (obj.with) {
      for (const item of obj.with) recurse(item)
    }
    if (obj.extra) {
      for (let item of obj.extra) {
        recurse(item)
      }
    }
  }

  recurse(component)
  return texts.join('').replaceAll('  ', ' ')
}
