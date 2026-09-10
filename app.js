const state = {
  campaign: null,
  history: [],
};

const conversation = document.getElementById('conversation');
const promptForm = document.getElementById('promptForm');
const promptInput = document.getElementById('promptInput');
const manifest = document.getElementById('manifest');
const emptyState = document.getElementById('emptyState');
const campaignSummary = document.getElementById('campaignSummary');
const continuity = document.getElementById('continuity');
const scenes = document.getElementById('scenes');
const sceneCount = document.getElementById('sceneCount');
const resetButton = document.getElementById('resetButton');
const exportButton = document.getElementById('exportButton');
const demoButton = document.getElementById('demoButton');

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

function inferCampaign(text) {
  const lower = text.toLowerCase();
  const durationMatch = lower.match(/(\d{1,3})\s*(?:second|sec|s)\b/);
  const duration = durationMatch ? Math.max(6, Math.min(120, Number(durationMatch[1]))) : 30;

  let platform = 'Multi-platform';
  if (lower.includes('tiktok')) platform = 'TikTok';
  else if (lower.includes('instagram') || lower.includes('reel')) platform = 'Instagram Reels';
  else if (lower.includes('youtube') || lower.includes('short')) platform = 'YouTube Shorts';

  let tone = 'Premium, confident, contemporary';
  if (lower.includes('cinematic')) tone = 'Cinematic, premium, emotionally controlled';
  if (lower.includes('funny') || lower.includes('humour') || lower.includes('humor')) tone = 'Witty, fast, self-aware';
  if (lower.includes('luxury')) tone = 'Luxury, restrained, tactile';

  const audienceMatch = text.match(/(?:aimed at|for|targeting)\s+([^,.]+)/i);
  const audience = audienceMatch ? audienceMatch[1].trim() : 'Young professionals';

  let product = 'Product';
  const productPatterns = [
    /ad for (?:an? )?([^,.]+?)(?: aimed| targeting| for |\.|$)/i,
    /campaign for (?:an? )?([^,.]+?)(?: aimed| targeting| for |\.|$)/i,
    /promote (?:an? )?([^,.]+?)(?: aimed| targeting| for |\.|$)/i,
  ];
  for (const pattern of productPatterns) {
    const match = text.match(pattern);
    if (match) {
      product = match[1].trim();
      break;
    }
  }
  if (product === 'Product' && lower.includes('magnesium')) product = 'Magnesium supplement';

  const aspect = platform === 'Multi-platform' ? '9:16 master + adaptable crops' : '9:16';
  const sceneTotal = duration <= 15 ? 3 : duration <= 35 ? 4 : 5;
  const baseSceneDuration = Math.max(2, Math.floor(duration / sceneTotal));

  const actor = 'One consistent lead: late-20s professional, grounded wardrobe, natural performance';
  const visualLanguage = tone.toLowerCase().includes('cinematic')
    ? 'Moody directional light, shallow depth of field, controlled camera motion'
    : 'Clean contrast, purposeful camera movement, premium commercial realism';

  const sceneBlueprints = [
    {
      title: 'Pattern interrupt',
      visual: `Open on the audience pain point in a visually immediate way. ${visualLanguage}.`,
      voiceover: `Some days ask more from you than your routine gives back.`,
      prompt: `Commercial video, ${audience}, opening tension, ${tone}, ${aspect}, realistic product-ad cinematography, no logos except approved product packaging.`,
    },
    {
      title: 'Product reveal',
      visual: `Introduce ${product} with one confident hero movement. Keep the same lead and lighting world.`,
      voiceover: `That is where a simpler evening ritual can make a difference.`,
      prompt: `Premium hero reveal of ${product}, tactile macro details, same lead character, continuity preserved, ${tone}, ${aspect}.`,
    },
    {
      title: 'Benefit in context',
      visual: `Show the product fitting naturally into the user's real routine rather than presenting a feature list.`,
      voiceover: `Built to fit the routine you already have — not become another one to manage.`,
      prompt: `${audience} using ${product} naturally in context, believable lifestyle moment, continuity locked, ${tone}, ${aspect}.`,
    },
    {
      title: 'Outcome',
      visual: `Resolve the opening tension with a calm, credible outcome. Avoid exaggerated transformation language.`,
      voiceover: `Less friction. A better finish to the day.`,
      prompt: `Resolved lifestyle scene, same character, same wardrobe family, calm premium finish, ${tone}, ${aspect}.`,
    },
    {
      title: 'End frame',
      visual: `Finish on a clean product lock-up with one concise call to action and clear negative space.`,
      voiceover: `${product}. Keep the routine simple.`,
      prompt: `Minimal product end frame for ${product}, clean composition, premium commercial lighting, space for CTA, ${aspect}.`,
    },
  ];

  const chosen = sceneBlueprints.slice(0, sceneTotal);
  const used = baseSceneDuration * sceneTotal;
  const remainder = duration - used;

  const sceneList = chosen.map((scene, index) => ({
    id: index + 1,
    duration: baseSceneDuration + (index < remainder ? 1 : 0),
    ...scene,
  }));

  return {
    product,
    audience,
    duration,
    platform,
    aspect,
    tone,
    objective: 'Turn one conversational brief into an execution-ready video campaign manifest.',
    continuity: {
      actor,
      visualLanguage,
      guardrail: 'Preserve product identity, lead character, wardrobe family, lighting logic, and camera language across revisions unless explicitly changed.',
    },
    scenes: sceneList,
    revision: 1,
  };
}

function rebuildSceneDurations(campaign) {
  const count = campaign.duration <= 15 ? 3 : campaign.duration <= 35 ? 4 : 5;
  while (campaign.scenes.length > count) campaign.scenes.pop();
  while (campaign.scenes.length < count) {
    const next = inferCampaign(`Create a ${campaign.duration} second ad for ${campaign.product} aimed at ${campaign.audience}.`).scenes[campaign.scenes.length];
    campaign.scenes.push(next);
  }
  const base = Math.floor(campaign.duration / count);
  let remainder = campaign.duration - base * count;
  campaign.scenes.forEach((scene, i) => {
    scene.id = i + 1;
    scene.duration = base + (remainder-- > 0 ? 1 : 0);
  });
}

function reviseCampaign(text) {
  const c = state.campaign;
  const lower = text.toLowerCase();
  const changes = [];

  const sceneMatch = lower.match(/scene\s*(\d+)/);
  if (sceneMatch) {
    const scene = c.scenes.find(s => s.id === Number(sceneMatch[1]));
    if (scene) {
      if (lower.includes('darker')) {
        scene.visual += ' Shift exposure darker with stronger negative fill and practical highlights.';
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

  const durationMatch = lower.match(/(?:cut|make|change)(?: it)?(?: to)?\s*(\d{1,3})\s*(?:second|sec|s)\b/);
  if (durationMatch) {
    c.duration = Math.max(6, Math.min(120, Number(durationMatch[1])));
    rebuildSceneDurations(c);
    changes.push(`duration to ${c.duration}s`);
  }

  if (lower.includes('tiktok')) {
    c.platform = 'TikTok';
    c.aspect = '9:16';
    changes.push('platform to TikTok');
  } else if (lower.includes('instagram') || lower.includes('reel')) {
    c.platform = 'Instagram Reels';
    c.aspect = '9:16';
    changes.push('platform to Instagram Reels');
  } else if (lower.includes('youtube') || lower.includes('shorts')) {
    c.platform = 'YouTube Shorts';
    c.aspect = '9:16';
    changes.push('platform to YouTube Shorts');
  }

  const audienceMatch = text.match(/(?:change|switch|set)(?: the)? audience (?:to|as)\s+([^,.]+)/i);
  if (audienceMatch) {
    c.audience = audienceMatch[1].trim();
    c.scenes.forEach(scene => {
      scene.prompt = scene.prompt.replace(/young professionals/gi, c.audience);
    });
    changes.push(`audience to ${c.audience}`);
  }

  if (lower.includes('same actor') || lower.includes('same character') || lower.includes('keep the actor')) {
    c.continuity.guardrail = 'Hard-lock the same lead identity, facial features, age, body type, wardrobe family, and styling across every shot and revision.';
    changes.push('lead-character continuity lock');
  }

  if (lower.includes('luxury')) {
    c.tone = 'Luxury, restrained, tactile';
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
  scenes.innerHTML = c.scenes.map(scene => `
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

function processPrompt(text) {
  addMessage('user', text);

  if (!state.campaign || /\b(create|make|build|generate|develop)\b/i.test(text) && /\b(ad|campaign|video)\b/i.test(text)) {
    state.campaign = inferCampaign(text);
    addMessage('director', `Campaign created. I built a ${state.campaign.duration}-second ${state.campaign.platform} production manifest for ${state.campaign.product}, aimed at ${state.campaign.audience}. The continuity lock will stay intact across revisions.`);
  } else {
    const changes = reviseCampaign(text);
    addMessage('director', `Updated without rebuilding the campaign: ${changes.join(', ')}. The rest of the production state remains locked.`);
  }

  renderManifest();
}

promptForm.addEventListener('submit', event => {
  event.preventDefault();
  const text = promptInput.value.trim();
  if (!text) return;
  promptInput.value = '';
  processPrompt(text);
});

document.querySelectorAll('.suggestion').forEach(button => {
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
    await new Promise(resolve => setTimeout(resolve, 650));
    processPrompt(step);
  }
});

addMessage('director', 'Ready. Describe the campaign you want me to direct.');
renderManifest();
