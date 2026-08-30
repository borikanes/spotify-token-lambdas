const { test, describe, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

process.env.TO_EMAIL = 'inbox@example.com';
process.env.FROM_EMAIL = 'noreply@example.com';

const lambda = require('./index.js');
const { ses } = lambda._test;

/**
 * Stubs `ses.send`, recording every command and returning a canned result.
 *
 * @param {Function} [handler] - Receives each command; its return value is the result.
 * @returns {Array<Object>} The live log of commands sent.
 */
function stubSes(handler = () => ({ MessageId: 'msg-1', $metadata: { httpStatusCode: 200 } })) {
    const sent = [];
    mock.method(ses, 'send', async (command) => {
        sent.push(command);
        return handler(command);
    });
    return sent;
}

afterEach(() => mock.restoreAll());

describe('feedback handler', () => {
    test('sends the message to the configured inbox', async () => {
        const sent = stubSes();

        await lambda.handler({ 'body-json': { message: 'Feedback: the app is great' } });

        assert.equal(sent.length, 1);
        const input = sent[0].input;
        assert.deepEqual(input.Destination.ToAddresses, ['inbox@example.com']);
        assert.equal(input.Source, 'noreply@example.com');
        assert.equal(input.Message.Body.Text.Data, 'Feedback: the app is great');
        assert.equal(input.Message.Subject.Data, 'Feedback/Help SongUpdater');
    });

    test('returns the SES result on success', async () => {
        stubSes();

        const result = await lambda.handler({ 'body-json': { message: 'hi' } });

        assert.equal(result.MessageId, 'msg-1');
    });

    test('returns the error instead of throwing when SES rejects the send', async () => {
        // The iOS client only reads the HTTP status code, but the handler must not
        // throw — an unhandled rejection would surface as a 502 rather than the
        // gateway's normal response.
        stubSes(() => { throw new Error('SES is unavailable'); });

        const result = await lambda.handler({ 'body-json': { message: 'hi' } });

        assert.ok(result instanceof Error);
        assert.equal(result.message, 'SES is unavailable');
    });

    test('throws when the gateway mapping did not produce body-json', async () => {
        // Deliberate: surfacing a malformed mapping loudly beats emailing an
        // empty message. This is pre-existing behavior, pinned so the v3
        // migration did not quietly change it.
        const sent = stubSes();

        await assert.rejects(() => lambda.handler({}), TypeError);
        assert.equal(sent.length, 0, 'no mail should be sent for a malformed event');
    });
});
