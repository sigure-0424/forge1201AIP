package com.forgeaip.auxmod.data;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Represents the live status of a managed bot, as received from the orchestrator WebSocket.
 */
public class BotStatus {

    public String botId;
    public double health;
    public double food;
    public double x;
    public double y;
    public double z;
    public String dimension;
    public boolean isExecuting;
    public List<Map<String, Object>> actionQueue;
    public String currentAction; // first item in actionQueue or "idle"

    /** Convenience accessor for currentAction, returning "idle" if null/empty. */
    public String getCurrentAction() {
        return (currentAction != null && !currentAction.isEmpty()) ? currentAction : "idle";
    }

    public BotStatus() {
        this.botId = "";
        this.health = 0.0;
        this.food = 0.0;
        this.x = 0.0;
        this.y = 0.0;
        this.z = 0.0;
        this.dimension = "overworld";
        this.isExecuting = false;
        this.actionQueue = new ArrayList<>();
        this.currentAction = "idle";
    }

    /**
     * Returns a short display string for the HUD.
     * Example: [MyBot] ❤15.0 🍗18.0 (100,64,200) mine_oak_log
     */
    public String toHudString() {
        int px = (int) Math.round(x);
        int py = (int) Math.round(y);
        int pz = (int) Math.round(z);
        String action = (currentAction != null && !currentAction.isEmpty()) ? currentAction : "idle";
        return String.format("[%s] \u276415.0 health:%.0f food:%.0f (%d,%d,%d) %s",
                botId, health, food, px, py, pz, action);
    }

    /**
     * Returns a formatted HUD line using heart and food symbols.
     */
    public String toHudLine() {
        int px = (int) Math.round(x);
        int py = (int) Math.round(y);
        int pz = (int) Math.round(z);
        String action = (currentAction != null && !currentAction.isEmpty()) ? currentAction : "idle";
        // Use ASCII alternatives for symbols since Minecraft font may not have all Unicode
        return String.format("[%s] HP:%.0f FD:%.0f (%d,%d,%d) %s",
                botId, health, food, px, py, pz, action);
    }

    @Override
    public String toString() {
        return String.format("BotStatus{id='%s', hp=%.1f, food=%.1f, pos=(%.1f,%.1f,%.1f), dim='%s', action='%s'}",
                botId, health, food, x, y, z, dimension, currentAction);
    }
}
