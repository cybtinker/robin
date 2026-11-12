/**
 * Fledgling research inbox: paste into a Google Apps Script project bound to a Google Sheet.
 * The app POSTs one batch at a time: { device, version, rows: [ {...}, ... ], files: [ { name, b64 } ] }.
 * Rows go to the "tries" sheet; audio goes to a Drive folder named "Fledgling audio".
 * Apps Script never gives the script the sender's IP address, so none is stored.
 */
const FOLDER_NAME = 'Fledgling audio';
const MAX_ROWS_PER_POST = 500;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const device = String(body.device || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
    if (!device) return out({ ok: false, error: 'no device id' });
    let rows = (body.rows || []).slice(0, MAX_ROWS_PER_POST);
    const sheet = SpreadsheetApp.getActive().getSheetByName('tries') || SpreadsheetApp.getActive().insertSheet('tries');
    const lock = LockService.getScriptLock(); lock.waitLock(20000);
    try {
      let header = sheet.getLastRow() ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] : ['received_at'];
      rows.forEach(r => Object.keys(r).forEach(k => { if (header.indexOf(k) < 0) header.push(k); }));
      sheet.getRange(1, 1, 1, header.length).setValues([header]);
      const now = new Date();
      // skip tries we already have (a tester may press Send twice)
      const ti = header.indexOf('take_id'), ri = header.indexOf('try_id'), have = {};
      if (sheet.getLastRow() > 1 && ti >= 0 && ri >= 0) sheet.getRange(2, 1, sheet.getLastRow() - 1, header.length).getValues().forEach(v => { have[v[ti] + '/' + v[ri]] = 1; });
      rows = rows.filter(r => !have[r.take_id + '/' + r.try_id]);
      const values = rows.map(r => header.map(k => k === 'received_at' ? now : (r[k] == null ? '' : String(r[k]).slice(0, 5000))));
      if (values.length) sheet.getRange(sheet.getLastRow() + 1, 1, values.length, header.length).setValues(values);
    } finally { lock.releaseLock(); }
    let saved = 0;
    const files = body.files || [];
    if (files.length) {
      const root = folder_(DriveApp.getRootFolder(), FOLDER_NAME), dir = folder_(root, device);
      files.forEach(f => {
        const name = String(f.name || '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
        if (!/\.wav$/.test(name)) return;
        const bytes = Utilities.base64Decode(f.b64 || '');
        if (!bytes.length || bytes.length > MAX_FILE_BYTES) return;
        if (dir.getFilesByName(name).hasNext()) return; // already have it
        dir.createFile(Utilities.newBlob(bytes, 'audio/wav', name)); saved++;
      });
    }
    return out({ ok: true, rows: rows.length, files: saved }); // rows = new rows added
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function folder_(parent, name) { const it = parent.getFoldersByName(name); return it.hasNext() ? it.next() : parent.createFolder(name); }
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function doGet() { return out({ ok: true, app: 'Fledgling research inbox' }); }
