import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newNote,encryptNote,decryptNote} from '../src/notes.mjs';
test('encrypted recovery binds the vault and rejects tampering and wrong passwords',async()=>{
  const note=newNote(),password='test-only sufficiently long password',binding='10143:isolated-vault';
  const backup=await encryptNote(note,password,binding);
  assert.equal(JSON.stringify(backup).includes(note.export()),false);
  assert.equal((await decryptNote(backup,password,binding)).commitment,note.commitment);
  await assert.rejects(decryptNote(backup,'another sufficiently long password',binding));
  await assert.rejects(decryptNote(backup,password,'another vault'));
  await assert.rejects(decryptNote({...backup,ciphertext:backup.ciphertext.slice(0,-4)+'AAAA'},password,binding));
  await assert.rejects(encryptNote(note,'short',binding));
});
