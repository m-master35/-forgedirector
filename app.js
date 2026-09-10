const state = {
  campaign: null,
  history: [],
};

const $ = (id) => document.getElementById(id);
const conversation = $('conversation');
const promptForm = $('promptForm');
const promptInput = $('promptInput');
const manifest = $('manifest');
const emptyState = $('emptyState');
const campaignSummary = $('campaignSummary');
const continuity = $('continuity');
const scenes = $('scenes');
const sceneCount = $('sceneCount');
const resetButton = $('resetButton');
const exportButton = $('exportButton');
const demoButton = $('demoButton');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

function addMessage(role, text) {
  state.history.push({ role, text, at: new Date().toISOString() });
  const item = document.createElement('div');
  item.className = `message ${role}`;
  item.innerHTML = `<span class="speaker">${role === 'user' ? 'You' : 'ForgeDirector'}</span>${escapeHtml(text)}`;
  conversation.appendChild(item);
  conversation.scrollTop = conversation.scrollHeight;
}

function parseDuration(text, fallback = 30) {
  const match = text.toLowerCase().match(/(\d{1,3})\s*[- ]?\s*(?:second|seconds|sec|secs|s)\b/);
  return match ? clamp(Number(match[1]), 6, 120) : fallback;
}

function parsePlatform(text, fallback = 'Multi-platform') {
  const lower = text.toLowerCase();
  if (lower.includes('tiktok')) return 'TikTok';
  if (lower.includes('instagram') || lower.includes('reel')) return 'Instagram Reels';
  if (lower.includes('youtube') || lower.includes('short')) return 'YouTube Shorts';
  return fallback;
}

function parseAudience(text, fallback = 'Young professionals') {
  const strong = text.match(/(?:aimed at|targeting|targeted at)\s+([^,.]+)/i);
  if (strong) return strong[1].trim();

  const ending = text.match(/\bfor\s+([^,.]+?)\s*$/i);
  if (ending && !/^(?:a|an|the)\s+(?:ad|advert|campaign|video)\b/i.test(ending[1])) {
    return ending[1].trim();
  }

  return fallback;
}

function parseProduct(text, fallback = 'Product') {
  const patterns = [
    /\bad for\s+(?:an?\s+)?([^,.]+?)(?=\s+(?:aimed at|targeting|targeted at)\b|[,.]|$)/i,
    /\bcampaign for\s+(?:an?\s+)?([^,.]+?)(?=\s+(?:aimed at|targeting|targeted at)\b|[,.]|$)/i,
    /\bpromote\s+(?:an?\s+)?([^,.]+?)(?=\s+(?:aimed at|targeting|targeted at)\b|[,.]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }

  if (/magnesium/i.test(text)) return 'Magnesium supplement';
  return fallback;
}

function inferTone(text) {
  const lower = text.toLowerCase();
  if (lower.includes('luxury')) return 'Luxury, restrained, tactile';
  if (lower.includes('cinematic')) return 'Cinematic, premium, emotionally controlled';
  if (lower.includes('funny') || lower.includes('humour') || lower.includes('humor')) return 'Witty, fast, self-aware';
  return 'Premium, confident, contemporary';
}

function sceneBlueprints(campaign) {
  const { product, audience, tone, aspect } = campaign;
  const cinematic = tone.toLowerCase().includes('cinematic');
  const visualLanguage = cinematic
    ? 'Moody directional light, shallow depth of field, controlled camera motion'
    : 'Clean contrast, purposeful camera movement, premium commercial realism';

  return [
    {
      title: 'Pattern interrupt',
      visual: `Open on a recognizable tension for ${audience}. ${visualLanguage}.`,
      voiceover: 'Some days ask more from you than your routine gives back.',
      prompt: `Commercial video for ${audience}, opening tension, ${tone}, ${aspect}, realistic product-ad cinematography, no logos except approved product packaging.`,
    },
    {
      title: 'Product reveal',
      visual: `Introduce ${product} with one confident hero movement. Keep the same lead and lighting world.`,
      voiceover: 'That is where a simpler ritual can make a difference.',
      prompt: `Premium hero reveal of ${product}, tactile macro details, same lead character, continuity preserved, ${tone}, ${aspect}.`,
    },
    {
      title: 'Benefit in context',
      visual: `Show ${product} fitting naturally into the real routine of ${audience}, not as a floating feature list.`,
      voiceover: 'Built to fit the routine you already have — not become another one to manage.',
      prompt: `${audience} using ${product} naturally in context, believable lifestyle moment, continuity locked, ${tone}, ${aspect}.`,
    },
    {
      title: 'Outcome',
      visual: 'Resolve the opening tension with a calm, credible outcome. Avoid exaggerated transformation language.',
      voiceover: 'Less friction. A better finish to the day.',
      prompt: `Resolved lifestyle scene, same character, same wardrobe family, calm premium finish, ${tone}, ${aspect}.`,
    },
    {
      title: 'End frame',
      visual: 'Finish on a clean product lock-up with one concise call to action and clear negative space.',
      voiceover: `${product}. Keep the routine simple.`,
      prompt: `Minimal product end frame for ${product}, clean composition, premium commercial lighting, space for CTA, ${aspect}.`,
    },
  ];
}

function sceneTotalFor(duration) {
  if (duration <= 15) return 3;
  if (duration <= 35) return 4;
  return 5;
}

function distributeDurations(sceneList, totalDuration) {
  const base = Math.floor(totalDuration / sceneList.length);
  let remainder = totalDuration - base * sceneList.length;
  sceneList.forEach((scene, index) => {
    scene.id = index + 1;
    scene.duration = base + (remainder-- > 0 ? 1 : 0);
  });
}

function buildScenes(campaign, previousScenes = []) {
  const targetCount = sceneTotalFor(campaign.duration);
  const defaults = sceneBlueprints(campaign).slice(0, targetCount);
  const built = defaults.map((base, index) => {
    const previous = previousScenes[index];
    return previous
      ? { ...base, ...previous, id: index + 1 }
      : { ...base, id: index + 1, duration: 0 };
  });

  distributeDurations(built, campaign.duration);
  return built;
}

function inferCampaign(text) {
  const duration = parseDuration(text, 30);
  const platform = parsePlatform(text);
  const audience = parseAudience(text);
  const product = parseProduct(text);
  const tone = inferTone(text);
  const aspect = platform === 'Multi-platform' ? '9:16 master + adaptable crops' : '9:16';

  const campaign = {
    product,
    audience,
    duration,
    platform,
    aspect,
    tone,
    objective: 'Turn one conversational brief into an execution-ready video campaign manifest.',
    continuity: {
      actor: 'One consistent lead: late-20s professional, grounded wardrobe, natural performance',
      visualLanguage: tone.toLowerCase().includes('cinematic')
        ? 'Moody directional light, shallow depth of field, controlled camera motion'
        : 'Clean contrast, purposeful camera movement, premium commercial realism',
      guardrail: 'Preserve product identity, lead character, wardrobe family, lighting logic, and camera language across revisions unless explicitly changed.',
    },
    scenes: [],
    revision: 1,
  };

  campaign.scenes = buildScenes(campaign);
  return campaign;
}

function refreshDerivedPrompts(campaign) {
  const defaults = sceneBlueprints(campaign);
  campaign.scenes.forEach((scene, index) => {
    const base = defaults[index];
    if (!base) return;
    scene.prompt = base.prompt;
    if (!scene.visual.includes('Shift exposure darker')) scene.visual = base.visual;
  });
}

function reviseCampaign(text) {
  const c = state.campaign;
  const lower = text.toLowerCase();
  const changes = [];

  const duration = parseDuration(text, null);
  if (duration && /(cut|change|make|shorten|length|duration)/i.test(text)) {
    c.duration = duration;
    c.scenes = buildScenes(c, c.scenes);
    changes.push(`duration to ${c.duration}s`);
  }

  const platform = parsePlatform(text, null);
  if (platform) {
    c.platform = platform;
    c.aspect = '9:16';
    refreshDerivedPrompts(c);
    changes.push(`platform to ${platform}`);
  }

  const audienceMatch = text.match(/(?:change|switch|set)(?: the)? audience (?:to|as)\s+([^,.]+)/i);
  if (audienceMatch) {
    c.audience = audienceMatch[1].trim();
    refreshDerivedPrompts(c);
    changes.push(`audience to ${c.audience}`);
  }

  const sceneMatch = lower.match(/scene\s*(\d+)/);
  if (sceneMatch) {
    const scene = c.scenes.find((item) => item.id === Number(sceneMatch[1]));
    if (scene) {
      if (lower.includes('darker')) {
        scene.visual = `${scene.visual.replace(/\s*Shift exposure darker.*$/i, '')} Shift exposure darker with stronger negative fill and practical highlights.`;
        scene.prompt += ' Darker exposure, richer shadows, practical highlights, controlled contrast.';
        changes.push(`scene ${scene.id} lighting`);
      }
      if (lower.includes('cinematic')) {
        scene.visual += ' Increase cinematic camera intent with slower, motivated movement.';
        scene.prompt += ' Cinematic lensing, motivated camera movement, shallow depth of field.';
        changes.push(`scene ${scene.id} cinematography`);
      }
      if (lower.includes('shorter')) {
        scene.duration = Math.max(2, scene.duration - 1);
        changes.push(`scene ${scene.id} duration`);
      }
    }
  }

  if (lower.includes('same actor') || lower.includes('same character') || lower.includes('keep the actor')) {
    c.continuity.guardrail = 'Hard-lock the same lead identity, facial features, age, body type, wardrobe family, and styling across every shot and revision.';
    changes.push('lead-character continuity lock');
  }

  if (lower.includes('luxury')) {
    c.tone = 'Luxury, restrained, tactile';
    refreshDerivedPrompts(c);
    changes.push('tone to luxury');
  }

  if (!changes.length) {
    c.scenes[0].prompt += ` Additional direction: ${text.trim()}`;
    changes.push('creative direction added to scene 1');
  }

  c.revision += 1;
  return changes;
}

function renderManifest() {
  const c = state.campaign;
  if (!c) {
    manifest.classList.add('hidden');
    emptyState.classList.remove('hidden');
    exportButton.disabled = true;
    return;
  }

  emptyState.classList.add('hidden');
  manifest.classList.remove('hidden');
  exportButton.disabled = false;

  const summary = [
    ['Product', c.product],
    ['Audience', c.audience],
    ['Duration', `${c.duration}s`],
    ['Platform', c.platform],
    ['Format', c.aspect],
    ['Tone', c.tone],
    ['Revision', `v${c.revision}`],
    ['Workflow', 'Stateful'],
  ];

  campaignSummary.innerHTML = summary.map(([label, value]) => `
    <div class="summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
  `).join('');

  continuity.innerHTML = `
    <p><strong>Lead:</strong> ${escapeHtml(c.continuity.actor)}</p>
    <p><strong>Visual system:</strong> ${escapeHtml(c.continuity.visualLanguage)}</p>
    <p><strong>Revision rule:</strong> ${escapeHtml(c.continuity.guardrail)}</p>
  `;

  sceneCount.textContent = `${c.scenes.length} scenes`;
  scenes.innerHTML = c.scenes.map((scene) => `
    <article class="scene-card">
      <div class="scene-top">
        <span class="scene-number">Scene ${scene.id}</span>
        <span class="scene-duration">${scene.duration}s</span>
      </div>
      <h5>${escapeHtml(scene.title)}</h5>
      <p class="scene-row"><b>Visual</b>${escapeHtml(scene.visual)}</p>
      <p class="scene-row"><b>Voiceover</b>${escapeHtml(scene.voiceover)}</p>
      <p class="scene-row"><b>Generation prompt</b>${escapeHtml(scene.prompt)}</p>
    </article>
  `).join('');
}

function isNewCampaignRequest(text) {
  if (!state.campaign) return true;
  return /\b(create|build|generate|develop)\b/i.test(text) && /\b(ad|advert|campaign|video)\b/i.test(text);
}

function processPrompt(text) {
  addMessage('user', text);

  if (isNewCampaignRequest(text)) {
    state.campaign = inferCampaign(text);
    const c = state.campaign;
    addMessage('director', `Campaign created. I built a ${c.duration}-second ${c.platform} production manifest for ${c.product}, aimed at ${c.audience}. The continuity lock will stay intact across revisions.`);
  } else {
    const changes = reviseCampaign(text);
    addMessage('director', `Updated without rebuilding the campaign: ${changes.join(', ')}. Unrelated production decisions remain locked.`);
  }

  renderManifest();
}

promptForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = promptInput.value.trim();
  if (!text) return;
  promptInput.value = '';
  processPrompt(text);
});

document.querySelectorAll('.suggestion').forEach((button) => {
  button.addEventListener('click', () => processPrompt(button.textContent.trim()));
});

resetButton.addEventListener('click', () => {
  state.campaign = null;
  state.history = [];
  conversation.innerHTML = '';
  renderManifest();
  addMessage('director', 'Ready. Describe the campaign you want me to direct.');
});

exportButton.addEventListener('click', () => {
  if (!state.campaign) return;
  const payload = {
    exportedAt: new Date().toISOString(),
    campaign: state.campaign,
    conversation: state.history,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'forgedirector-production-manifest.json';
  link.click();
  URL.revokeObjectURL(url);
});

demoButton.addEventListener('click', async () => {
  resetButton.click();
  const steps = [
    'Create a premium 30-second ad for a magnesium supplement aimed at young professionals.',
    'Make scene 2 darker and more cinematic.',
    'Change the audience to gym users.',
    'Keep the same actor and make a TikTok version and cut it to 15 seconds.',
  ];

  for (const step of steps) {
    await new Promise((resolve) => setTimeout(resolve, 650));
    processPrompt(step);
  }
});

addMessage('director', 'Ready. Describe the campaign you want me to direct.');
renderManifest();
