const mineflayer = require('mineflayer');
const MockForgeServer = require('./mock_forge_server');
const ForgeHandshakeStateMachine = require('../src/forge_handshake_state_machine');

async function runTest() {
    console.log('--- Starting FML3 Handshake Logic Test ---');
    
    const server = new MockForgeServer(25566); // Use a different port to avoid conflicts
    
    const bot = mineflayer.createBot({
        host: '127.0.0.1\0FML3\0',
        port: 25566,
        username: 'TestBotFML3',
        version: '1.20.1'
    });

    let handshakeComplete = false;

    bot.on('inject_allowed', () => {
        console.log('[Bot] Client injected, initializing ForgeHandshakeStateMachine');
        const handshake = new ForgeHandshakeStateMachine(bot._client);
        
        // We can't easily listen for 'handshake_complete' unless we add it to the state machine
        // For now, let's just see if the bot logs in.
    });

    bot.on('login', () => {
        console.log('[Bot] Logged in successfully!');
        handshakeComplete = true;
        bot.quit();
        server.close();
        console.log('--- Test Passed ---');
        process.exit(0);
    });

    bot.on('error', (err) => {
        console.error('[Bot] Error:', err);
        server.close();
        process.exit(1);
    });

    bot.on('kicked', (reason) => {
        console.error('[Bot] Kicked:', reason);
        server.close();
        process.exit(1);
    });

    // Timeout after 10 seconds
    setTimeout(() => {
        if (!handshakeComplete) {
            console.error('[Test] Timeout reached without successful login.');
            server.close();
            process.exit(1);
        }
    }, 10000);
}

runTest().catch(err => {
    console.error('[Test] Unexpected error:', err);
    process.exit(1);
});
