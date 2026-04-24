const MODULE_ID = "bi-2024-inspired-condition";
const SOCKET_NAME = `module.${MODULE_ID}`;
const FLAG_SCOPE = MODULE_ID;
const LEGACY_FLAG_SCOPE = "bi2024";
const STATUS_ID = `${MODULE_ID}.inspired`;
const EFFECT_NAME = "Inspired";
const EFFECT_ICON = "icons/sundries/scrolls/scroll-symbol-eye-brown.webp";
const ROLL_TYPES = new Set(["attack", "save", "check", "skill"]);
const RECENT_APPLICATIONS = new Map();
const HANDLED_PROMPTS = new Set();
const HANDLED_APPLICATION_MESSAGES = new Set();
const ROLL_HOOKS = {
  "dnd5e.rollAttack": "attack",
  "dnd5e.rollAbilityCheck": "check",
  "dnd5e.rollSavingThrow": "save",
  "dnd5e.rollSkill": "skill"
};

Hooks.once("init", () => {
  registerSettings();
  registerStatusEffect();
});

Hooks.once("ready", () => {
  if (game.system.id !== "dnd5e") {
    console.warn(`${MODULE_ID} | This module is intended for the dnd5e system.`);
  }

  game.modules.get(MODULE_ID).api = {
    applyBardicInspiration,
    removeBardicInspiration,
    getBardicDie,
    hasBardicInspiration,
    promptUseInspiration
  };

  if (game.socket) game.socket.on(SOCKET_NAME, onSocketMessage);

  Hooks.on("dnd5e.postUseActivity", onPostUseActivity);
  Hooks.on("createChatMessage", onCreateChatMessage);
  Hooks.on("renderChatMessage", onRenderChatMessage);
  Hooks.on("midi-qol.RollComplete", onMidiRollComplete);
  registerRollHooks();

  debug("Module ready");
});

function registerSettings() {
  const settings = [
    ["replaceExisting", {
      name: "Replace Existing Inspiration",
      hint: "If a target already has Inspired, replace it with the newly applied Bardic Inspiration.",
      type: Boolean,
      default: false
    }],
    ["allowMultipleTargets", {
      name: "Allow Multiple Targets",
      hint: "If enabled, Bardic Inspiration can be applied to every currently targeted token.",
      type: Boolean,
      default: false
    }],
    ["allowSelfInspiration", {
      name: "Allow Self Inspiration",
      hint: "If enabled, a bard can inspire themselves when explicitly targeted.",
      type: Boolean,
      default: false
    }],
    ["promptOnlyOnFailedRollsWhenKnown", {
      name: "Prompt Only On Known Failed Rolls",
      hint: "If the module can confidently determine a roll succeeded, it will skip the prompt.",
      type: Boolean,
      default: true
    }],
    ["promptOnInitiative", {
      name: "Prompt On Initiative",
      hint: "If enabled, initiative rolls may trigger Bardic Inspiration prompts when they can be identified as checks.",
      type: Boolean,
      default: false
    }],
    ["debug", {
      name: "Debug Logging",
      hint: "Enable verbose console logging for troubleshooting.",
      type: Boolean,
      default: false
    }]
  ];

  for (const [key, data] of settings) {
    game.settings.register(MODULE_ID, key, {
      scope: "world",
      config: true,
      ...data
    });
  }
}

function registerStatusEffect() {
  CONFIG.statusEffects ??= [];
  if (CONFIG.statusEffects.some((entry) => entry.id === STATUS_ID)) return;
  CONFIG.statusEffects.push({
    id: STATUS_ID,
    name: EFFECT_NAME,
    img: EFFECT_ICON
  });
}

async function onPostUseActivity(activity, usageConfig, results) {
  try {
    const item = activity?.item;
    if (!isBardicInspirationItem(item)) return;
    rememberApplicationMessage(results?.message);
    if (!shouldHandleActivityApplication(item, results?.message)) return;

    await applyFromCurrentTargets(item.actor ?? activity.actor, item);
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to process Bardic Inspiration activity`, error);
  }
}

async function onCreateChatMessage(message, options, userId) {
  try {
    if (message.getFlag(MODULE_ID, "ignorePrompt")) return;
    if (userId !== game.user.id) return;

    if (looksLikeBardicInspirationMessage(message)) {
      if (wasApplicationMessageHandled(message)) return;
      rememberApplicationMessage(message);
      const sourceActor = getActorFromMessage(message);
      await applyFromCurrentTargets(sourceActor, message.item ?? null, { chatFallback: true });
    }
  } catch (error) {
    console.error(`${MODULE_ID} | Failed while handling chat message`, error);
  }
}

async function onRenderChatMessage(message, html) {
  try {
    if (message.getFlag(MODULE_ID, "ignorePrompt")) return;

    const actor = getActorFromMessage(message);
    if (!actor) return;
    if (!isPromptUserForActor(actor)) return;

    const effect = findInspiredEffect(actor);
    if (!effect) return;

    const rollInfo = extractRollInfoFromRenderedMessage(message, html);
    if (!rollInfo.valid) return;

    injectChatPromptButton(html, actor, rollInfo);
  } catch (error) {
    console.error(`${MODULE_ID} | Failed while rendering chat message`, error);
  }
}

function onMidiRollComplete(workflow) {
  if (!game.modules.get("midi-qol")?.active) return;
  if (!workflow?.itemCardUuid || !workflow?.actor) return;

  debug("Midi-QOL workflow observed", {
    actor: workflow.actor.name,
    item: workflow.item?.name
  });

  const attackRoll = workflow.attackRoll;
  if (attackRoll) {
    void maybePromptFromRoll("attack", [attackRoll], { subject: workflow.actor, workflowId: workflow.id ?? workflow.uuid ?? null });
  }
}

function registerRollHooks() {
  for (const [hookName, rollType] of Object.entries(ROLL_HOOKS)) {
    Hooks.on(hookName, (rolls, data) => {
      void maybePromptFromRoll(rollType, rolls, data);
    });
  }
}


async function applyFromCurrentTargets(sourceActor, sourceItem = null, { chatFallback = false } = {}) {
  if (!sourceActor) return;

  const targets = getEligibleTargetActors(sourceActor);
  if (!targets.length) {
    ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.noTarget`));
    return;
  }

  const filteredTargets = enforceTargetCount(targets);
  const results = [];
  for (const targetActor of filteredTargets) {
    const applied = await applyBardicInspiration(sourceActor, targetActor, { sourceItem, chatFallback });
    if (applied) results.push(targetActor);
  }

  if (results.length) {
    ui.notifications.info(game.i18n.format(`${MODULE_ID}.notifications.applied`, {
      count: results.length
    }));
  }
}

function getEligibleTargetActors(sourceActor) {
  const allowSelf = setting("allowSelfInspiration");
  const actors = Array.from(game.user.targets ?? [])
    .map((token) => token?.actor)
    .filter((actor) => actor);

  return actors.filter((actor) => {
    if ((actor.uuid !== sourceActor.uuid) || allowSelf) return true;
    ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.selfNotAllowed`));
    return false;
  });
}

function enforceTargetCount(targetActors) {
  if (setting("allowMultipleTargets") || (targetActors.length <= 1)) return targetActors;
  ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.multipleTargets`));
  return [targetActors[0]];
}

async function applyBardicInspiration(sourceActor, target, { sourceItem = null, chatFallback = false } = {}) {
  const targetActor = getActorFromTarget(target);
  if (!sourceActor || !targetActor) return false;

  const effectKey = `${sourceActor.uuid}->${targetActor.uuid}`;
  if (wasRecentlyApplied(effectKey)) {
    debug("Skipping duplicate Bardic Inspiration application", { effectKey, chatFallback });
    return false;
  }

  const existing = findInspiredEffect(targetActor);
  if (existing && !setting("replaceExisting")) {
    ui.notifications.warn(game.i18n.format(`${MODULE_ID}.notifications.alreadyInspired`, {
      actor: targetActor.name
    }));
    rememberApplication(effectKey);
    return false;
  }

  const die = getBardicDie(sourceActor);
  const now = Date.now();
  const moduleVersion = game.modules.get(MODULE_ID)?.version ?? "0.0.0";
  const effectData = {
    name: EFFECT_NAME,
    img: EFFECT_ICON,
    origin: sourceItem?.uuid ?? sourceActor.uuid,
    disabled: false,
    statuses: [STATUS_ID],
    duration: {
      seconds: 3600,
      startTime: game.time?.worldTime ?? 0
    },
    flags: {
      [FLAG_SCOPE]: {
        sourceActorUuid: sourceActor.uuid,
        sourceActorName: sourceActor.name,
        die,
        appliedAt: now,
        used: false,
        moduleVersion
      },
      core: {
        statusId: STATUS_ID
      }
    }
  };

  if (existing) await existing.update(effectData);
  else await targetActor.createEmbeddedDocuments("ActiveEffect", [effectData]);

  rememberApplication(effectKey);
  debug("Applied Bardic Inspiration", {
    source: sourceActor.name,
    target: targetActor.name,
    die
  });
  return true;
}

async function removeBardicInspiration(targetActor) {
  const actor = getActorFromTarget(targetActor);
  const effect = actor ? findInspiredEffect(actor) : null;
  if (!effect) return false;
  await effect.delete();
  return true;
}

function getBardicDie(actor) {
  const bardLevel = getBardLevel(actor);
  if (!bardLevel) {
    console.warn(`${MODULE_ID} | No Bard class found on ${actor?.name ?? "unknown actor"}, defaulting Bardic Inspiration die to d6.`);
    return "d6";
  }
  if (bardLevel >= 15) return "d12";
  if (bardLevel >= 10) return "d10";
  if (bardLevel >= 5) return "d8";
  return "d6";
}

function getBardLevel(actor) {
  if (!actor) return 0;

  let bardLevel = 0;
  for (const item of actor.items ?? []) {
    if (item.type !== "class") continue;
    if ((item.name ?? "").trim().toLowerCase() !== "bard") continue;
    bardLevel += Number(item.system?.levels ?? item.system?.level ?? 0);
  }

  if (bardLevel > 0) return bardLevel;

  for (const classItem of Object.values(actor.classes ?? {})) {
    const className = (classItem?.name ?? "").trim().toLowerCase();
    if (className !== "bard") continue;
    bardLevel += Number(classItem.system?.levels ?? classItem.levels ?? classItem._source?.system?.levels ?? 0);
  }

  return bardLevel;
}

function hasBardicInspiration(actor) {
  const targetActor = getActorFromTarget(actor);
  return Boolean(findInspiredEffect(targetActor));
}

async function promptUseInspiration(actor, rollData = {}) {
  const targetActor = getActorFromTarget(actor);
  if (!targetActor) return false;

  const effect = findInspiredEffect(targetActor);
  if (!effect) return false;

  const owner = getPromptUser(targetActor);
  if (!owner) {
    console.warn(`${MODULE_ID} | No active owner or GM available to prompt for ${targetActor.name}.`);
    return false;
  }

  const request = {
    type: "prompt",
    promptId: rollData.promptId ?? buildPromptId(targetActor, rollData),
    targetUserId: owner.id,
    actorUuid: targetActor.uuid,
    effectUuid: effect.uuid,
    rollData: {
      actorName: targetActor.name,
      rollType: rollData.rollType ?? "d20 Test",
      total: rollData.total ?? 0,
      messageUuid: rollData.messageUuid ?? null,
      messageId: rollData.messageId ?? null,
      failureKnown: rollData.failureKnown ?? false,
      failed: rollData.failed ?? null
    }
  };

  if (HANDLED_PROMPTS.has(request.promptId)) return false;

  if (owner.id === game.user.id) {
    await showInspirationPrompt(request);
    return true;
  }

  game.socket?.emit(SOCKET_NAME, request);
  return true;
}

async function maybePromptFromRoll(rollType, rolls, data = {}) {
  const actor = getActorFromRollContext(data);
  if (!actor) return;
  if (!isPromptUserForActor(actor)) return;

  const effect = findInspiredEffect(actor);
  if (!effect) return;

  const flags = getEffectFlags(effect);
  if (flags.used) return;

  const rollInfo = extractRollInfoFromRolls(rollType, rolls, data);
  if (!rollInfo.valid) return;
  if (HANDLED_PROMPTS.has(rollInfo.promptId)) return;

  const shouldPrompt = !setting("promptOnlyOnFailedRollsWhenKnown")
    || !rollInfo.failureKnown
    || Boolean(rollInfo.failed);

  if (!shouldPrompt) {
    debug("Skipping prompt because roll appears to have succeeded", {
      actor: actor.name,
      rollInfo
    });
    return;
  }

  await promptUseInspiration(actor, {
    rollType: rollInfo.label,
    total: rollInfo.total,
    messageUuid: rollInfo.messageUuid,
    messageId: rollInfo.messageId,
    failureKnown: rollInfo.failureKnown,
    failed: rollInfo.failed,
    promptId: rollInfo.promptId
  });
}

function extractRollInfoFromMessage(message) {
  return extractRollInfoFromRolls(
    "message",
    Array.isArray(message.rolls) ? message.rolls : [],
    { message }
  );
}

function extractRollInfoFromRenderedMessage(message, html) {
  const fromMessage = extractRollInfoFromMessage(message);
  if (fromMessage.valid) return fromMessage;

  const root = html?.[0];
  if (!root) return { valid: false };

  const text = root.textContent?.toLowerCase?.() ?? "";
  const hasEligibleLabel = [
    "attack",
    "saving throw",
    "save",
    "ability check",
    "skill"
  ].some((entry) => text.includes(entry));

  const hasD20Text = text.includes("1d20") || text.includes("d20");
  if (!hasEligibleLabel || !hasD20Text) return { valid: false };

  const totalText = root.querySelector?.(".dice-total")?.textContent?.trim?.() ?? "";
  const total = Number.parseInt(totalText, 10);
  const rollType = normalizeRollType(text);
  if (!rollType) return { valid: false };

  return {
    valid: true,
    total: Number.isFinite(total) ? total : 0,
    rollType,
    label: humanizeRollType(rollType),
    failureKnown: false,
    failed: null,
    messageUuid: message?.uuid ?? null,
    messageId: message?.id ?? null,
    promptId: buildRollPromptId({ message }, rollType, null, Number.isFinite(total) ? total : 0)
  };
}

function extractRollInfoFromRolls(baseRollType, rolls, data = {}) {
  const message = data?.message ?? null;
  const dnd5eRoll = message?.getFlag?.("dnd5e", "roll") ?? {};
  const midiFlags = data?.workflow?.hitTargets ? data.workflow : (message?.flags?.["midi-qol"] ?? {});
  const firstRoll = rolls[0] ?? null;
  const total = Number(firstRoll?.total ?? 0);
    const typeString = [
    baseRollType,
    dnd5eRoll.type,
    dnd5eRoll.rollType,
    firstRoll?.options?.rollType,
    message?.flavor
  ].filter(Boolean).join(" ").toLowerCase();

  const isInitiative = typeString.includes("initiative")
    || Boolean(message?.getFlag?.("core", "initiativeRoll"))
    || Boolean(firstRoll?.options?.initiative);
  if (isInitiative && !setting("promptOnInitiative")) {
    return { valid: false };
  }

  const hasD20 = rolls.some((roll) => {
    if (roll.dice?.some((die) => die.faces === 20)) return true;
    return /\bd20\b/i.test(roll.formula ?? "");
  });
  if (!hasD20) return { valid: false };

  const normalizedRollType = normalizeRollType(typeString);
  if (!normalizedRollType || !ROLL_TYPES.has(normalizedRollType)) return { valid: false };

  const targetNumber = Number(
    dnd5eRoll.target?.value
    ?? dnd5eRoll.targetValue
    ?? dnd5eRoll.dc
    ?? dnd5eRoll.ac
    ?? data?.targetValue
    ?? data?.dc
    ?? data?.ac
    ?? midiFlags.targetDC
    ?? midiFlags.ac
    ?? NaN
  );

  let failureKnown = Number.isFinite(targetNumber);
  let failed = failureKnown ? total < targetNumber : null;

  if (!failureKnown && game.modules.get("midi-qol")?.active) {
    const hasHits = Array.isArray(midiFlags.hitTargets) && (midiFlags.hitTargets.length > 0);
    const hasMisses = Array.isArray(midiFlags.hitTargets) && !hasHits && (normalizedRollType === "attack");
    if (hasHits || hasMisses) {
      failureKnown = true;
      failed = hasMisses;
    }
  }

  return {
    valid: true,
    total,
      rollType: normalizedRollType,
      label: humanizeRollType(normalizedRollType),
    failureKnown,
    failed,
    messageUuid: message?.uuid ?? null,
    messageId: message?.id ?? null,
      promptId: buildRollPromptId(data, normalizedRollType, firstRoll, total)
  };
}

function injectChatPromptButton(html, actor, rollInfo) {
  if (!html?.length) return;
  if (html[0]?.querySelector?.("[data-bi2024-button]")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("data-bi2024-button", "true");
  button.className = "bi2024-chat-button";
  button.innerHTML = `<i class="fas fa-music"></i> Bardic Inspiration`;
  button.addEventListener("click", async () => {
    await promptUseInspiration(actor, {
      rollType: rollInfo.label,
      total: rollInfo.total,
      messageUuid: rollInfo.messageUuid,
      messageId: rollInfo.messageId,
      failureKnown: rollInfo.failureKnown,
      failed: rollInfo.failed,
      promptId: `${rollInfo.promptId}|button`
    });
  });

  const wrapper = document.createElement("div");
  wrapper.className = "bi2024-chat-button-wrap";
  wrapper.appendChild(button);

  const actions = html[0].querySelector(".card-buttons");
  const content = html[0].querySelector(".message-content");
  if (actions) actions.appendChild(wrapper);
  else if (content) content.appendChild(wrapper);
}

function normalizeRollType(typeString) {
  if (!typeString) return null;
  if (typeString.includes("damage")) return null;
  if (typeString.includes("healing")) return null;
  if (typeString.includes("death")) return null;
  if (typeString.includes("tool")) return null;
  if (typeString.includes("attack")) return "attack";
  if (typeString.includes("saving throw") || typeString.includes("save")) return "save";
  if (typeString.includes("skill")) return "skill";
  if (typeString.includes("ability") || typeString.includes("check")) return "check";
  return null;
}

function humanizeRollType(rollType) {
  switch (rollType) {
    case "attack": return "Attack Roll";
    case "save": return "Saving Throw";
    case "skill": return "Ability Check";
    case "check": return "Ability Check";
    default: return "D20 Test";
  }
}

function findInspiredEffect(actor) {
  if (!actor) return null;
  return actor.effects.find((effect) => {
    const statuses = effect.statuses;
    const hasStatus = Array.isArray(statuses) ? statuses.includes(STATUS_ID) : statuses?.has?.(STATUS_ID);
    return hasStatus || Boolean(getEffectFlags(effect)?.die);
  }) ?? null;
}

function looksLikeBardicInspirationMessage(message) {
  if (message.getFlag(MODULE_ID, "createdByModule")) return false;
  const candidates = [
    message.item?.name,
    message.flavor,
    message.content,
    message.getFlag("dnd5e", "item")?.name,
    message.getFlag("dnd5e", "activity")?.name
  ].filter(Boolean).map((value) => String(value).toLowerCase());

  return candidates.some((value) => value.includes("bardic inspiration"));
}

function isBardicInspirationItem(item) {
  if (!item) return false;
  const identifier = String(item.system?.identifier ?? "").trim().toLowerCase();
  const name = String(item.name ?? "").trim().toLowerCase();
  return (identifier === "bardic-inspiration") || name.includes("bardic inspiration");
}

function shouldHandleActivityApplication(item, message) {
  if (!item?.actor) return false;
  const authorId = message?.user?.id;
  if (authorId && (authorId !== game.user.id)) return false;
  if (!authorId && !item.actor.isOwner && !game.user.isGM) return false;
  if (message?.getFlag(MODULE_ID, "createdByModule")) return false;
  return true;
}

function getActorFromTarget(target) {
  if (!target) return null;
  if (target.documentName === "Actor") return target;
  if (target.actor) return target.actor;
  if (target.document?.actor) return target.document.actor;
  return null;
}

function getActorFromMessage(message) {
  const token = ChatMessage.getSpeakerToken?.(message.speaker);
  if (token?.actor) return token.actor;
  const actor = ChatMessage.getSpeakerActor?.(message.speaker);
  if (actor) return actor;
  return game.actors?.get(message.speaker?.actor) ?? null;
}

function getPromptUser(actor) {
  const activeOwners = game.users.filter((user) => {
    if (!user.active || user.isGM) return false;
    return actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
  });
  if (activeOwners.length) return activeOwners[0];
  return game.users.find((user) => user.active && user.isGM) ?? null;
}

function isPromptUserForActor(actor) {
  const promptUser = getPromptUser(actor);
  return promptUser?.id === game.user.id;
}

async function onSocketMessage(data) {
  if (!data || (data.targetUserId !== game.user.id)) return;
  if (data.type === "prompt") {
    await showInspirationPrompt(data);
  }
}

async function showInspirationPrompt(request) {
  if (request.promptId && HANDLED_PROMPTS.has(request.promptId)) return;
  const actor = await fromUuid(request.actorUuid);
  if (!actor) return;

  const effect = request.effectUuid ? await fromUuid(request.effectUuid) : findInspiredEffect(actor);
  if (!effect) return;

  const effectFlags = getEffectFlags(effect);
  if (effectFlags.used) return;

  if (request.promptId) HANDLED_PROMPTS.add(request.promptId);

  const rollData = request.rollData ?? {};
  const die = effectFlags.die ?? "d6";
  const sourceName = effectFlags.sourceActorName ?? "Unknown Bard";
  const total = rollData.total ?? 0;
  const body = `
    <div class="bi2024-dialog">
      <p><strong>${actor.name}</strong></p>
      <p>${rollData.rollType ?? "D20 Test"} total: <strong>${total}</strong></p>
      <p>Bardic Inspiration die: <strong>${die}</strong></p>
      <p>Source bard: <strong>${sourceName}</strong></p>
    </div>
  `;

  const choice = await new Promise((resolve) => {
    new Dialog({
      title: "Use Bardic Inspiration?",
      content: body,
      buttons: {
        use: {
          label: "Roll Inspiration",
          callback: () => resolve("use")
        },
        skip: {
          label: "Do Not Use",
          callback: () => resolve("skip")
        }
      },
      default: "skip",
      close: () => resolve("skip")
    }).render(true);
  });

  if (choice !== "use") return;
  await spendBardicInspiration(actor, effect, request.rollData ?? {});
}

async function spendBardicInspiration(actor, effect, rollData) {
  const effectFlags = getEffectFlags(effect);
  if (effectFlags.used) return;

  await effect.update({ [`flags.${FLAG_SCOPE}.used`]: true });

  const dieFormula = `1${effectFlags.die ?? "d6"}`;
  const roll = await (new Roll(dieFormula)).evaluate({ async: true });
  const rollMode = game.settings.get("core", "rollMode");

  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: `${effectFlags.sourceActorName ?? "Bard"} grants Bardic Inspiration`,
    flags: {
      [MODULE_ID]: {
        createdByModule: true,
        ignorePrompt: true
      }
    }
  }, { rollMode });

  const originalTotal = Number(rollData.total ?? 0);
  const newTotal = originalTotal + Number(roll.total ?? 0);
  const content = `
    <div class="bi2024-summary">
      <p><strong>${actor.name}</strong> uses Bardic Inspiration.</p>
      <p>${rollData.rollType ?? "Roll"}: ${originalTotal} + ${roll.total} = <strong>${newTotal}</strong></p>
    </div>
  `;

  await ChatMessage.create({
    user: game.user.id,
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    flags: {
      [MODULE_ID]: {
        createdByModule: true,
        ignorePrompt: true
      }
    }
  }, { rollMode });

  await removeInspiredEffect(actor, effect);
}

function wasRecentlyApplied(key) {
  const previous = RECENT_APPLICATIONS.get(key);
  if (!previous) return false;
  return (Date.now() - previous) < 1500;
}

function rememberApplication(key) {
  RECENT_APPLICATIONS.set(key, Date.now());
}

function getApplicationMessageKey(message) {
  return message?.uuid ?? message?.id ?? null;
}

function rememberApplicationMessage(message) {
  const key = getApplicationMessageKey(message);
  if (!key) return;
  HANDLED_APPLICATION_MESSAGES.add(key);
}

function wasApplicationMessageHandled(message) {
  const key = getApplicationMessageKey(message);
  if (!key) return false;
  return HANDLED_APPLICATION_MESSAGES.has(key);
}

function getActorFromRollContext(data = {}) {
  const subject = data?.subject;
  if (!subject) return null;
  if (subject.documentName === "Actor") return subject;
  if (subject.actor) return subject.actor;
  return null;
}

async function removeInspiredEffect(actor, effect) {
  const current = effect?.id ? actor?.effects?.get(effect.id) : null;
  if (current) {
    await current.delete();
    return;
  }

  const fallback = findInspiredEffect(actor);
  if (fallback) await fallback.delete();
}

function getEffectFlags(effect) {
  if (!effect) return {};
  return effect.flags?.[FLAG_SCOPE] ?? effect.flags?.[LEGACY_FLAG_SCOPE] ?? {};
}

function buildPromptId(actor, rollData = {}) {
  return [
    actor?.uuid ?? "unknown-actor",
    rollData.rollType ?? "d20",
    rollData.total ?? 0,
    rollData.messageUuid ?? "no-message"
  ].join("|");
}

function buildRollPromptId(data, rollType, roll, total) {
  return [
    getActorFromRollContext(data)?.uuid ?? "unknown-actor",
    rollType,
    total,
    roll?.formula ?? "no-formula",
    data?.workflowId ?? data?.message?.uuid ?? "no-workflow"
  ].join("|");
}

function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

function debug(message, data) {
  if (!setting("debug")) return;
  console.log(`${MODULE_ID} | ${message}`, data ?? "");
}
