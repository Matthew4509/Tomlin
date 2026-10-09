// Connect Claude (src/claude.ts): the prompt that makes Claude the project manager of this PC's network, to copy into
// Claude. It holds no PIN, setup code or key; the server writes it, so it always names this copy's own folder, version,
// handover and port.
'use strict';

const claudeDlg = $('#claude-dlg');

$('#claude-open').addEventListener('click', async () => {
  $('#claude-said').textContent = '';
  $('#claude-prompt').value = '';
  claudeDlg.showModal();
  try {
    $('#claude-prompt').value = (await api('/api/claude')).prompt;
  } catch (e) {
    $('#claude-said').textContent = e.message;
  }
});

$('#claude-copy').addEventListener('click', async () => {
  const ok = await app.copyText($('#claude-prompt').value);
  $('#claude-said').textContent = ok ? 'Copied: paste it into Claude.' : 'Could not copy here: select the text in the box and copy it with Ctrl+C.';
});
