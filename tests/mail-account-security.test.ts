import { describe, expect, it } from 'vitest';
import { validateWritable } from '../apps/mail/src/domain/validation';
import { patchObject } from '../apps/mail/src/domain/model';
describe('Mail writable property authorization', () => {
  it('separates organization, draft and send authority', () => {
    expect(() => validateWritable('Email', {'keywords/$seen': true}, 'update', ['mail.organize'])).not.toThrow();
    expect(() => validateWritable('Email', {subject:'Changed'}, 'update', ['mail.organize'])).toThrow('mail.draft');
    expect(() => validateWritable('EmailSubmission', {emailId:'e',identityId:'i'}, 'create', ['mail.draft'])).toThrow('mail.send');
    expect(() => validateWritable('EmailSubmission', {emailId:'e',identityId:'i'}, 'create', ['mail.edit'])).toThrow('mail.send');
    expect(() => validateWritable('Domain', {name:'example.com'}, 'create', ['mail.read'])).toThrow('mail.manage');
  });
  it('prevents overwriting server facts through roots and patch paths', () => {
    for (const [type,input] of [['Identity',{verified:true}],['Identity',{'verified/value':true}],['Domain',{sendingVerified:true}],['Email',{blobId:'foreign'}],['EmailSubmission',{status:'sent'}],['EmailSubmission',{emailSnapshot:{blobId:'foreign'}}]] as const) {
      expect(() => validateWritable(type,input,'update',['mail.manage','mail.draft','mail.send'])).toThrow();
    }
    expect(() => validateWritable('Mailbox',{name:'Inbox',role:'inbox'},'create',['mail.organize'])).toThrow('server owned');
  });
  it('rejects prototype pollution recursively and in decoded patch paths', () => {
    for (const input of [{ '__proto__/polluted':true }, {'constructor/prototype/polluted':true}, JSON.parse('{"keywords":{"__proto__":{"polluted":true}}}')]) {
      expect(() => validateWritable('Email',input,'update',['mail.organize'])).toThrow();
    }
    expect(() => patchObject({id:'e'}, {'__proto__/mailPollution':true})).toThrow();
    expect(({} as Record<string, unknown>).mailPollution).toBeUndefined();
  });
  it('rejects attachment bytes and path-shaped blob references', () => {
    expect(() => validateWritable('Email',{attachments:[{blobId:'../another-account/a'}]},'create',['mail.draft'])).toThrow();
    expect(() => validateWritable('Email',{attachments:[{blobId:'safe',bytes:[1]}]},'create',['mail.draft'])).toThrow();
    expect(() => validateWritable('Email',{attachments:[{blobId:'a-123',name:'report.pdf'}]},'create',['mail.draft'])).not.toThrow();
  });
});
