import { Identity } from '@semaphore-protocol/identity';
import { Group } from '@semaphore-protocol/group';
import { generateProof, verifyProof } from '@semaphore-protocol/proof';
const crypto = globalThis.crypto;
const base64 = value => btoa(String.fromCharCode(...new Uint8Array(value)));
const bytes = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const enc = new TextEncoder();
const context = enc.encode('flurbo.privacy-note-backup.v1');
export function newNote() { return new Identity(); }
export async function proveWithdrawal(note, members, scope, message, artifacts) {
  const group = new Group(members.map(BigInt));
  if (!members.some(value => BigInt(value) === note.commitment)) throw Error('Note is not deposited in this group');
  const proof = await generateProof(note, group, BigInt(message), BigInt(scope), 8, artifacts);
  if (!await verifyProof(proof)) throw Error('Local proof verification failed');
  return proof;
}
async function key(password, salt, usage) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 1024) throw Error('Use a backup password of at least 16 characters');
  const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2', salt, iterations:600000, hash:'SHA-256'}, material, {name:'AES-GCM',length:256}, false, usage);
}
export async function encryptNote(note, password, binding) {
  const salt=crypto.getRandomValues(new Uint8Array(16)), iv=crypto.getRandomValues(new Uint8Array(12));
  const plaintext=enc.encode(JSON.stringify({secret:note.export(),binding}));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:context},await key(password,salt,['encrypt']),plaintext);
  return {schema:'flurbo.privacy-note-backup.v1',salt:base64(salt),iv:base64(iv),ciphertext:base64(ciphertext)};
}
export async function decryptNote(backup,password,expectedBinding) {
  if (backup?.schema!=='flurbo.privacy-note-backup.v1'||typeof backup.ciphertext!=='string'||backup.ciphertext.length>8192)throw Error('Invalid backup');
  const salt=bytes(backup.salt),iv=bytes(backup.iv);
  if(salt.length!==16||iv.length!==12)throw Error('Invalid backup');
  const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:context},await key(password,salt,['decrypt']),bytes(backup.ciphertext));
  const data=JSON.parse(new TextDecoder().decode(plaintext));
  if(data.binding!==expectedBinding)throw Error('Backup belongs to a different vault');
  return Identity.import(data.secret);
}
