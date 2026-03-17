const EventEmitter = require('events');
const ForgeHandshakeStateMachine = require('../src/forge_handshake_state_machine');
const assert = require('assert');

class MockClient extends EventEmitter {
    constructor() {
        super();
        this.sentPackets = [];
    }
    write(name, params) {
        this.sentPackets.push({ name, params });
        this.emit('write', name, params);
    }
}

async function runTest() {
    console.log('--- Starting FML3 Handshake Pure Logic Test ---');
    
    const client = new MockClient();
    client.state = 'login';
    const handshake = new ForgeHandshakeStateMachine(client);
    
    const innerChannel = 'fml:handshake';

    // 1. Simulate ServerHello (Disc 0)
    console.log('[Test] Simulating ServerHello');
    const serverHelloPayload = Buffer.from([0, 1, 3]); // Disc 0, version 1, protocol 3
    const wrapper0 = buildLoginWrapper(innerChannel, serverHelloPayload);
    
    client.emit('packet', { channel: 'fml:loginwrapper', data: wrapper0, messageId: 1 }, { name: 'login_plugin_request' });

    // Check response
    assert.strictEqual(client.sentPackets.length, 1);
    assert.strictEqual(client.sentPackets[0].name, 'login_plugin_response');
    assert.strictEqual(client.sentPackets[0].params.messageId, 1);
    
    let response0 = parseLoginWrapper(client.sentPackets[0].params.data);
    assert.strictEqual(response0.channel, innerChannel);
    assert.strictEqual(response0.payload[0], 1); // ClientHello discriminator
    assert.strictEqual(response0.payload[1], 3); // FML version 3

    console.log('[Test] ClientHello sent correctly.');

    // 2. Simulate ModList (Disc 1)
    console.log('[Test] Simulating ModList');
    const modListPayload = buildModListPayload(['minecraft', 'forge']);
    const wrapper1 = buildLoginWrapper(innerChannel, Buffer.concat([Buffer.from([1]), modListPayload]));
    
    client.emit('packet', { channel: 'fml:loginwrapper', data: wrapper1, messageId: 2 }, { name: 'login_plugin_request' });

    assert.strictEqual(client.sentPackets.length, 2);
    let response1 = parseLoginWrapper(client.sentPackets[1].params.data);
    assert.strictEqual(response1.payload[0], 2); // ModListReply discriminator
    
    console.log('[Test] ModListReply sent correctly.');

    // 3. Simulate Registry (Disc 3)
    console.log('[Test] Simulating Registry');
    const registryPayload = Buffer.from([3, 0]); // Disc 3, empty
    const wrapper2 = buildLoginWrapper(innerChannel, registryPayload);
    
    client.emit('packet', { channel: 'fml:loginwrapper', data: wrapper2, messageId: 3 }, { name: 'login_plugin_request' });

    assert.strictEqual(client.sentPackets.length, 3);
    let response2 = parseLoginWrapper(client.sentPackets[2].params.data);
    assert.strictEqual(response2.payload[0], 99); // HandshakeAck
    
    console.log('[Test] HandshakeAck sent correctly.');

    console.log('--- Pure Logic Test Passed ---');
}

// Helper functions for the test
function buildLoginWrapper(channel, payload) {
    const channelBuf = writeUtf(channel);
    const payloadLenBuf = writeVarIntBuf(payload.length);
    return Buffer.concat([channelBuf, payloadLenBuf, payload]);
}

function parseLoginWrapper(data) {
    let offset = 0;
    const { value: channelLen, bytesRead: clBr } = readVarInt(data, offset);
    offset += clBr;
    const channel = data.toString('utf8', offset, offset + channelLen);
    offset += channelLen;
    const { value: payloadLen, bytesRead: plBr } = readVarInt(data, offset);
    offset += plBr;
    const payload = data.subarray(offset, offset + payloadLen);
    return { channel, payload };
}

function buildModListPayload(mods) {
    const parts = [];
    parts.push(writeVarIntBuf(mods.length));
    for (const mod of mods) {
        parts.push(writeUtf(mod));
    }
    parts.push(writeVarIntBuf(0)); // Channels map
    parts.push(writeVarIntBuf(0)); // Registries list
    parts.push(writeVarIntBuf(0)); // DataPackRegistries list
    return Buffer.concat(parts);
}

function readVarInt(buffer, offset) {
    let numRead = 0;
    let result = 0;
    let read;
    do {
        read = buffer.readUInt8(offset + numRead);
        let value = (read & 0b01111111);
        result |= (value << (7 * numRead));
        numRead++;
    } while ((read & 0b10000000) != 0);
    return { value: result, bytesRead: numRead };
}

function writeVarIntBuf(value) {
    const bytes = [];
    do {
        let temp = (value & 0b01111111);
        value >>>= 7;
        if (value != 0) temp |= 0b10000000;
        bytes.push(temp);
    } while (value != 0);
    return Buffer.from(bytes);
}

function writeUtf(str) {
    const strBuf = Buffer.from(str, 'utf8');
    return Buffer.concat([writeVarIntBuf(strBuf.length), strBuf]);
}

runTest().catch(err => {
    console.error('[Test] Failed:', err);
    process.exit(1);
});
