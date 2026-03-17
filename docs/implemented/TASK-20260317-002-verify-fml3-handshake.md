# TASK-20260317-002-verify-fml3-handshake

## 1. Overview and Problem Statement
The current `ForgeHandshakeStateMachine` is implemented but only verified via a "require" smoke test. It lacks functional validation against a simulated Forge server, which is critical for ensuring it can successfully navigate the FML3 handshake sequence (S2CModList, S2CRegistry, etc.) and transition to the play state.

## 2. Success Criteria
- [ ] Create a mock server script to simulate an FML3 handshake.
- [ ] Implement a test case that runs the `ForgeHandshakeStateMachine` against the mock server.
- [ ] Verify that `ForgeHandshakeStateMachine` correctly parses `S2CModList` and sends a valid `C2SModListReply`.
- [ ] Verify that `ForgeHandshakeStateMachine` correctly acknowledges `S2CRegistry` and `S2CConfigData`.
- [ ] Verify that `registrySyncBuffer` is correctly populated.

## 3. Implementation Plan
1.  **Mock Server Development**: Create `tests/mock_forge_server.js` that uses `node-minecraft-protocol` to simulate a Forge server's login phase.
2.  **Test Script**: Create `tests/test_fml3_handshake_logic.js` to run the bot actuator (or a standalone handshake instance) against the mock server.
3.  **Fixes/Hardening**: Address any parsing errors or sequence issues discovered during testing.
4.  **Validation**: Run the new test script and ensure it passes.

## 4. Risks and Mitigations
- **Complexity of FML3 Protocol**: FML3 uses a `login_wrapper` channel which can be tricky to parse. Mitigation: Refer to existing `ForgeHandshakeStateMachine` and Forge source code.
- **Timing Issues**: Handshake sequences can be sensitive to timing. Mitigation: Use proper packet listeners and state transitions.

## 5. Execution Mode
- `local` (depends on local Node.js and `node-minecraft-protocol`)
