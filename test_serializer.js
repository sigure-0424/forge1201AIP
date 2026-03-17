const { Serializer } = require('minecraft-protocol');
const mcData = require('minecraft-data')('1.20.1');

const serializer = new Serializer(mcData.version.version, 'login');

const innerChannel = 'fml:handshake';
const replyPayload = Buffer.from([5, 0]);

const responseData = Buffer.alloc(1 + innerChannel.length + 1 + replyPayload.length);
responseData.writeUInt8(innerChannel.length, 0);
responseData.write(innerChannel, 1);
responseData.writeUInt8(replyPayload.length, 1 + innerChannel.length);
replyPayload.copy(responseData, 2 + innerChannel.length);

const packet = serializer.createPacketBuffer({
    name: 'login_plugin_response',
    params: {
        messageId: 0,
        successful: true,
        data: responseData
    }
});

console.log('Serialized packet bytes:', packet);
