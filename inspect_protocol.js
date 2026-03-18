const minecraftData = require('minecraft-data')
const mcData = minecraftData('1.20.1')
console.log(JSON.stringify(mcData.protocol.play.toClient.types, null, 2))
