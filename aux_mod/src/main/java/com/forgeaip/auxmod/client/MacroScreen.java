package com.forgeaip.auxmod.client;

import com.forgeaip.auxmod.AuxMod;
import com.forgeaip.auxmod.data.MacroManager;
import com.forgeaip.auxmod.network.OrchestratorClient;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.api.distmarker.OnlyIn;

import java.util.List;

/**
 * The Procedure Macro GUI screen (opened via F9).
 *
 * <p>Lists all saved macros with [Run] and [Delete] buttons. An [Add Macro]
 * button at the bottom opens an inline input area for condition + action text.
 */
@OnlyIn(Dist.CLIENT)
public class MacroScreen extends Screen {

    // Layout constants
    private static final int LIST_X = 10;
    private static final int LIST_Y = 30;
    private static final int ROW_HEIGHT = 22;
    private static final int ADD_SECTION_HEIGHT = 60;

    // Scroll state
    private int scrollOffset = 0;
    private static final int MAX_VISIBLE_ROWS = 8;

    // Add-macro sub-form state
    private boolean addFormVisible = false;
    private EditBox conditionBox;
    private EditBox actionBox;

    // Currently selected bot (first key from botStatuses, or empty)
    private String selectedBot = "";

    public MacroScreen() {
        super(Component.literal("Procedure Macros"));
    }

    // -------------------------------------------------------------------------
    // Screen lifecycle
    // -------------------------------------------------------------------------

    @Override
    protected void init() {
        super.init();
        refreshSelectedBot();
        buildWidgets();
    }

    private void refreshSelectedBot() {
        OrchestratorClient client = OrchestratorClient.getInstance();
        if (!client.botStatuses.isEmpty()) {
            selectedBot = client.botStatuses.keySet().iterator().next();
        }
    }

    private void buildWidgets() {
        clearWidgets();

        MacroManager mgr = MacroManager.getInstance();
        List<MacroManager.Macro> macros = mgr.getMacros();

        // Title bar close button
        addRenderableWidget(Button.builder(Component.literal("X"), btn -> onClose())
                .pos(this.width - 24, 4)
                .size(20, 14)
                .build());

        // Scroll buttons (if needed)
        if (macros.size() > MAX_VISIBLE_ROWS) {
            addRenderableWidget(Button.builder(Component.literal("^"), btn -> {
                if (scrollOffset > 0) { scrollOffset--; buildWidgets(); }
            }).pos(this.width - 46, LIST_Y).size(20, 14).build());

            addRenderableWidget(Button.builder(Component.literal("v"), btn -> {
                int maxScroll = Math.max(0, macros.size() - MAX_VISIBLE_ROWS);
                if (scrollOffset < maxScroll) { scrollOffset++; buildWidgets(); }
            }).pos(this.width - 46, LIST_Y + 16).size(20, 14).build());
        }

        // Macro rows
        int visibleCount = Math.min(MAX_VISIBLE_ROWS, macros.size() - scrollOffset);
        for (int i = 0; i < visibleCount; i++) {
            int idx = i + scrollOffset;
            MacroManager.Macro macro = macros.get(idx);
            int rowY = LIST_Y + i * ROW_HEIGHT;
            final int finalIdx = idx;

            // [Run] button
            addRenderableWidget(Button.builder(Component.literal("Run"), btn -> runMacro(finalIdx))
                    .pos(this.width - 90, rowY)
                    .size(36, 16)
                    .build());

            // [Delete] button
            addRenderableWidget(Button.builder(Component.literal("Del"), btn -> {
                MacroManager.getInstance().removeMacro(finalIdx);
                if (scrollOffset > 0 && scrollOffset >= MacroManager.getInstance().size()) {
                    scrollOffset = Math.max(0, scrollOffset - 1);
                }
                buildWidgets();
            }).pos(this.width - 50, rowY).size(36, 16).build());
        }

        // Add Macro button / form
        int addBtnY = LIST_Y + MAX_VISIBLE_ROWS * ROW_HEIGHT + 4;
        if (!addFormVisible) {
            addRenderableWidget(Button.builder(Component.literal("+ Add Macro"), btn -> {
                addFormVisible = true;
                buildWidgets();
            }).pos(LIST_X, addBtnY).size(100, 16).build());
        } else {
            // Condition field
            conditionBox = new EditBox(this.font,
                    LIST_X, addBtnY + 10, this.width - 20, 16,
                    Component.literal("Condition"));
            conditionBox.setHint(Component.literal("Condition (e.g. health < 6)"));
            conditionBox.setMaxLength(200);
            addRenderableWidget(conditionBox);

            // Action field
            actionBox = new EditBox(this.font,
                    LIST_X, addBtnY + 40, this.width - 20, 16,
                    Component.literal("Action JSON"));
            actionBox.setHint(Component.literal("Action JSON (e.g. [{\"action\":\"eat\"}])"));
            actionBox.setMaxLength(500);
            addRenderableWidget(actionBox);

            // Snippet buttons
            int snippetY = addBtnY + 60;
            addRenderableWidget(Button.builder(Component.literal("Current Pos"), btn -> {
                if (minecraft != null && minecraft.player != null) {
                    int px = (int) Math.round(minecraft.player.getX());
                    int py = (int) Math.round(minecraft.player.getY());
                    int pz = (int) Math.round(minecraft.player.getZ());
                    actionBox.setValue(String.format("[{\"action\":\"GoalBlock\",\"x\":%d,\"y\":%d,\"z\":%d}]", px, py, pz));
                }
            }).pos(LIST_X, snippetY).size(70, 16).build());

            addRenderableWidget(Button.builder(Component.literal("Eat"), btn -> {
                actionBox.setValue("[{\"action\":\"equip\",\"item\":\"cooked_beef\"},{\"action\":\"eat\"}]");
            }).pos(LIST_X + 74, snippetY).size(40, 16).build());

            addRenderableWidget(Button.builder(Component.literal("Follow"), btn -> {
                if (minecraft != null && minecraft.player != null) {
                    actionBox.setValue(String.format("[{\"action\":\"GoalFollow\",\"entity\":\"%s\"}]", minecraft.player.getName().getString()));
                }
            }).pos(LIST_X + 118, snippetY).size(50, 16).build());

            // Save / Cancel buttons
            int btnY = addBtnY + 80;
            addRenderableWidget(Button.builder(Component.literal("Save"), btn -> {
                String cond = conditionBox.getValue().trim();
                String act = actionBox.getValue().trim();
                if (!act.isEmpty()) {
                    MacroManager.getInstance().addMacro(new MacroManager.Macro(cond, act));
                }
                addFormVisible = false;
                buildWidgets();
            }).pos(LIST_X, btnY).size(50, 16).build());

            addRenderableWidget(Button.builder(Component.literal("Cancel"), btn -> {
                addFormVisible = false;
                buildWidgets();
            }).pos(LIST_X + 54, btnY).size(50, 16).build());
        }
    }

    // -------------------------------------------------------------------------
    // Actions
    // -------------------------------------------------------------------------

    private void runMacro(int index) {
        List<MacroManager.Macro> macros = MacroManager.getInstance().getMacros();
        if (index < 0 || index >= macros.size()) return;
        MacroManager.Macro macro = macros.get(index);

        refreshSelectedBot();
        if (selectedBot.isEmpty()) {
            Minecraft.getInstance().player.sendSystemMessage(
                    Component.literal("[ForgeAIP] No bot connected to run macro."));
            return;
        }

        String botId = selectedBot;
        String actionJson = macro.action;
        String body = String.format("{\"message\":\"%s\"}",
                OrchestratorClient.jsonEscape(actionJson));

        OrchestratorClient.getInstance()
                .postJson("/api/bots/" + botId + "/chat", body)
                .thenAccept(resp -> AuxMod.LOGGER.info("[ForgeAIP] Macro sent to {}: {}", botId, resp));

        Minecraft.getInstance().player.sendSystemMessage(
                Component.literal("[ForgeAIP] Running macro on " + botId + ": " + macro.condition));
    }

    // -------------------------------------------------------------------------
    // Rendering
    // -------------------------------------------------------------------------

    @Override
    public void render(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
        renderBackground(graphics);

        // Panel background
        graphics.fill(4, 4, this.width - 4, this.height - 4, 0xCC1A1A2E);

        // Title
        graphics.drawCenteredString(this.font,
                Component.literal("Procedure Macros"),
                this.width / 2, 10, 0xFFFFFFFF);

        // Bot selector label
        String botLabel = selectedBot.isEmpty() ? "No bot" : "Bot: " + selectedBot;
        graphics.drawString(this.font, botLabel, LIST_X, LIST_Y - 14, 0xFFAAAAAA, false);

        // Macro list headers
        graphics.drawString(this.font, "Condition | Action", LIST_X, LIST_Y - 2, 0xFF888888, false);

        MacroManager mgr = MacroManager.getInstance();
        List<MacroManager.Macro> macros = mgr.getMacros();
        int visibleCount = Math.min(MAX_VISIBLE_ROWS, macros.size() - scrollOffset);

        for (int i = 0; i < visibleCount; i++) {
            int idx = i + scrollOffset;
            MacroManager.Macro macro = macros.get(idx);
            int rowY = LIST_Y + i * ROW_HEIGHT;

            // Alternating row background
            int bgColor = (i % 2 == 0) ? 0x22FFFFFF : 0x11FFFFFF;
            graphics.fill(LIST_X - 2, rowY - 2, this.width - 96, rowY + 14, bgColor);

            // Condition text
            String condText = macro.condition.isEmpty() ? "(no condition)" : macro.condition;
            if (condText.length() > 22) condText = condText.substring(0, 21) + "..";
            graphics.drawString(this.font, condText, LIST_X, rowY + 2, 0xFFDDDDDD, false);

            // Action preview (below condition, smaller)
            String actPreview = macro.action;
            if (actPreview.length() > 30) actPreview = actPreview.substring(0, 29) + "..";
            graphics.drawString(this.font, actPreview, LIST_X, rowY + 11, 0xFF999999, false);
        }

        if (macros.isEmpty()) {
            graphics.drawCenteredString(this.font,
                    Component.literal("No macros. Click '+ Add Macro' to create one."),
                    this.width / 2, LIST_Y + 20, 0xFF666666);
        }

        // Add form labels
        if (addFormVisible) {
            int addBtnY = LIST_Y + MAX_VISIBLE_ROWS * ROW_HEIGHT + 4;
            graphics.drawString(this.font, "Condition:", LIST_X, addBtnY, 0xFFCCCCCC, false);
            graphics.drawString(this.font, "Action JSON:", LIST_X, addBtnY + 30, 0xFFCCCCCC, false);
        }

        super.render(graphics, mouseX, mouseY, partialTick);
    }

    // -------------------------------------------------------------------------
    // Input
    // -------------------------------------------------------------------------

    @Override
    public boolean mouseScrolled(double mouseX, double mouseY, double delta) {
        int maxScroll = Math.max(0, MacroManager.getInstance().size() - MAX_VISIBLE_ROWS);
        if (delta < 0 && scrollOffset < maxScroll) {
            scrollOffset++;
            buildWidgets();
            return true;
        } else if (delta > 0 && scrollOffset > 0) {
            scrollOffset--;
            buildWidgets();
            return true;
        }
        return super.mouseScrolled(mouseX, mouseY, delta);
    }

    @Override
    public boolean isPauseScreen() {
        return false;
    }
}
