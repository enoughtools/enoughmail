import { describe, expect, it, vi } from 'vitest';
import { executeAuthorizedJmap, type JmapRequest } from '../apps/mail/src/server/jmap-router';
import type { MailContext } from '../apps/mail/src/domain/model';

const operationId = 'be057880-e3dc-418e-9ab6-4886b59a33e9';
const request: JmapRequest = {
  using: ['urn:enough:params:jmap:mail'],
  methodCalls: [['Identity/resolve', { accountId: 'inbox', email: 'alias@example.test', ifInState: 'm7', operationId }, 'sender']],
};
function fixture(actions: string[]) {
  const context: MailContext = { accountId: 'inbox', organizationId: 'org', workspaceId: 'space', actor: { id: 'actor', actions } };
  const authorizeAccount = vi.fn(async () => context);
  const callAccount = vi.fn(async (_context: MailContext, single: JmapRequest) => ({ methodResponses: [[single.methodCalls[0][0], { accountId: 'inbox', oldState: 'm7', newState: 'm8', identity: { id: 'identity', email: 'alias@example.test' } }, 'sender']] as JmapRequest['methodCalls'], sessionState: 'session' }));
  const run = (input = request) => executeAuthorizedJmap({ request: input, workspace: { organizationId: 'org', workspaceId: 'space', actorId: 'actor' }, authorizeAccount, callAccount, sessionState: () => 'session' });
  return { run, authorizeAccount, callAccount };
}
describe('Custom sending address authorization routing', () => {
  it('requires sending authority without granting identity management', async () => {
    const f = fixture(['mail.send']);
    expect((await f.run()).methodResponses[0][0]).toBe('Identity/resolve');
    expect(f.authorizeAccount).toHaveBeenCalledWith('inbox', ['mail.send']);
    expect(f.callAccount.mock.calls[0][0].actor.actions).toEqual(['mail.send']);
  });
  it.each([['mail.read'], ['mail.draft'], ['mail.manage'], ['mail.edit']])('refuses a caller with only %s', async action => {
    const f = fixture([action]);
    expect((await f.run()).methodResponses[0]).toMatchObject(['error', { type: 'forbidden' }, 'sender']);
    expect(f.callAccount).not.toHaveBeenCalled();
  });
  it('preserves a product operation and its revision across transport retries', async () => {
    const f = fixture(['mail.send']);
    await f.run({ ...request, requestId: 'a326353a-a923-4a6a-bb8a-1648c748f733' });
    await f.run({ ...request, requestId: '70f81df4-59c1-45b3-a93e-62cc9ee30762' });
    expect(f.callAccount.mock.calls.map(call => call[1].methodCalls[0][1])).toEqual([request.methodCalls[0][1], request.methodCalls[0][1]]);
  });
  it('rejects malformed command IDs before dispatching an address claim', async () => {
    const f = fixture(['mail.send']);
    expect((await f.run({ ...request, methodCalls: [['Identity/resolve', { ...request.methodCalls[0][1], operationId: 'bad-id' }, 'sender']] })).methodResponses[0]).toMatchObject(['error', { type: 'invalidArguments' }, 'sender']);
    expect(f.callAccount).not.toHaveBeenCalled();
  });
});
