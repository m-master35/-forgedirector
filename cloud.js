(() => {
  const config = window.FORGE_DIRECTOR_CONFIG || {};
  const apiUrl = String(config.apiUrl || '').trim();
  if (!apiUrl) return;

  const localProcessPrompt = processPrompt;
  let busy = false;

  function normalizeCloudCampaign(ai, previous) {
    const previousScenes = previous?.scenes || [];
    const platform = ai.platform === 'General' ? 'Multi-platform' : (ai.platform || previous?.platform || 'Multi-platform');

    return {
      product: previous?.product || 'Campaign',
      audience: ai.audience || previous?.audience || 'General audience',
      duration: Number(ai.durationSeconds || previous?.duration || 15),
      platform,
      aspect: ai.aspectRatio || previous?.aspect || '9:16',
      tone: previous?.tone || 'AI-directed, production-ready',
      objective: ai.summary || previous?.objective || 'Turn conversational direction into an execution-ready campaign manifest.',
      continuity: {
        actor: ai.continuity?.leadCharacter || previous?.continuity?.actor || 'Lead character defined by the campaign brief',
        visualLanguage: previous?.continuity?.visualLanguage || 'Consistent production language across scenes',
        guardrail: ai.continuity?.locked
          ? 'Hard-lock lead identity and unrelated production decisions across revisions unless explicitly changed.'
          : (previous?.continuity?.guardrail || 'Preserve unrelated production decisions across revisions.'),
      },
      scenes: (ai.scenes || []).map((scene, index) => {
        const old = previousScenes.find((item) => item.id === scene.id) || previousScenes[index] || {};
        return {
          id: Number(scene.id || index + 1),
          title: old.title || `Scene ${scene.id || index + 1}`,
          duration: Number(scene.durationSeconds || 0),
          visual: scene.visualDirection || old.visual || '',
          voiceover: scene.voiceover || old.voiceover || '',
          prompt: scene.generationPrompt || old.prompt || '',
        };
      }),
      revision: previous ? Number(previous.revision || 1) + 1 : 1,
    };
  }

  async function cloudProcessPrompt(text) {
    const message = String(text || '').trim();
    if (!message || busy) return;

    busy = true;
    addMessage('user', message);
    const submitButton = promptForm.querySelector('button[type="submit"]');
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Directing…';
    }

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message,
          campaign: state.cloudCampaign || null,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.campaign) {
        throw new Error(payload.error || `Director request failed (${response.status}).`);
      }

      state.cloudCampaign = payload.campaign;
      state.campaign = normalizeCloudCampaign(payload.campaign, state.campaign);
      addMessage(
        'director',
        payload.campaign.changeSummary
          ? `AI update: ${payload.campaign.changeSummary}`
          : 'AI campaign manifest updated. Unrelated production decisions were preserved.'
      );
      renderManifest();

      const statusText = document.querySelector('.status span:last-child');
      if (statusText) statusText.textContent = 'Bedrock AI online';
    } catch (error) {
      addMessage('director', `Cloud director error: ${error.message}. The local simulation remains available if the cloud endpoint is disabled.`);
    } finally {
      busy = false;
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = 'Direct';
      }
    }
  }

  processPrompt = cloudProcessPrompt;

  demoButton.addEventListener('click', async (event) => {
    event.stopImmediatePropagation();
    resetButton.click();
    state.cloudCampaign = null;

    const steps = [
      'Create a premium 30-second ad for a magnesium supplement aimed at young professionals.',
      'Make scene 2 darker and more cinematic.',
      'Change the audience to gym users.',
      'Keep the same actor and make a TikTok version and cut it to 15 seconds.',
    ];

    for (const step of steps) {
      await processPrompt(step);
    }
  }, true);

  const statusText = document.querySelector('.status span:last-child');
  if (statusText) statusText.textContent = 'Bedrock AI ready';

  window.ForgeDirectorCloud = {
    processPrompt: cloudProcessPrompt,
    localProcessPrompt,
  };
})();
