const MockForgeServer = require('./mock_forge_server');
const AgentManager = require('../src/agent_manager');
const net = require('net');

async function getAvailablePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

async function runTest() {
    console.log('--- Starting E2E Integration Test ---');
    try {
        const port = await getAvailablePort();
        console.log(`[Test] Using port ${port}`);

        const mockServer = new MockForgeServer(port);
        const manager = new AgentManager();

        let botProcess = null;
        let testPassed = false;
        
        const originalHandleFmlResponse = mockServer.handleFmlResponse.bind(mockServer);
        mockServer.handleFmlResponse = function(params, serializer, deserializer, socket, username) {
            originalHandleFmlResponse(params, serializer, deserializer, socket, username);
            const wrapperData = params.data;
            let offset = 0;
            const { value: channelLen, bytesRead: clBr } = this.readVarInt(wrapperData, offset);
            offset += channelLen + clBr;
            const { value: payloadLen, bytesRead: plBr } = this.readVarInt(wrapperData, offset);
            offset += plBr;
            const payload = wrapperData.subarray(offset, offset + payloadLen);
            const disc = payload[0];
            
            if (disc === 99) {
                console.log('[Test] Handshake Ack received. Test Passed.');
                testPassed = true;
                
                // Cleanup
                if (botProcess) {
                    botProcess.kill('SIGKILL');
                }
                mockServer.close();
                console.log('--- E2E Integration Test Finished Successfully ---');
                process.exit(0);
            }
        };

        botProcess = manager.startBot('E2E_Test_Bot', { host: '127.0.0.1', port: port });

        botProcess.on('exit', (code) => {
            if (!testPassed) {
                console.error(`[Test] Bot process exited prematurely with code ${code}`);
                mockServer.close();
                process.exit(1);
            }
        });

        // Timeout
        setTimeout(() => {
            if (!testPassed) {
                console.error('[Test] Timeout waiting for handshake to complete.');
                if (botProcess) botProcess.kill('SIGKILL');
                mockServer.close();
                process.exit(1);
            }
        }, 15000);

    } catch (e) {
        console.error('[Test] Error during E2E test:', e);
        process.exit(1);
    }
}

runTest();
