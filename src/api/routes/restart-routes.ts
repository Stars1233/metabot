import type { RouteHandler } from './types.js';
import { jsonResponse, parseJsonBody } from './helpers.js';
import {
  cancelControlledRestart,
  prepareControlledRestart,
  RestartPreparationError,
} from '../../bridge/restart-coordinator.js';

export const handleRestartRoutes: RouteHandler = async (ctx, req, res, method, url) => {
  if (method === 'POST' && url === '/api/runtime/restart/prepare') {
    const body = await parseJsonBody(req);
    const requestId = stringField(body.requestId);
    if (!requestId) {
      jsonResponse(res, 400, { error: 'requestId is required' });
      return true;
    }
    try {
      const plan = await prepareControlledRestart({
        registry: ctx.registry,
        logger: ctx.logger,
        request: {
          requestId,
          ...(stringField(body.requesterBot) ? { requesterBot: stringField(body.requesterBot) } : {}),
          ...(stringField(body.requesterChat) ? { requesterChat: stringField(body.requesterChat) } : {}),
          ...(stringField(body.source) ? { source: stringField(body.source) } : {}),
          ...(stringField(body.reason) ? { reason: stringField(body.reason) } : {}),
          resume: body.resume !== false,
          force: body.force === true,
        },
      });
      jsonResponse(res, 200, {
        requestId: plan.requestId,
        status: plan.status,
        participantCount: plan.participants.length,
        activeCount: plan.participants.filter((participant) => participant.wasActive).length,
        prepareNoticesDelivered: plan.participants.filter((participant) => participant.prepareNotice === 'delivered').length,
      });
    } catch (error) {
      if (error instanceof RestartPreparationError) {
        jsonResponse(res, error.statusCode, { error: error.message });
      } else {
        throw error;
      }
    }
    return true;
  }

  if (method === 'POST' && url === '/api/runtime/restart/cancel') {
    const body = await parseJsonBody(req);
    const requestId = stringField(body.requestId);
    if (!requestId) {
      jsonResponse(res, 400, { error: 'requestId is required' });
      return true;
    }
    const plan = cancelControlledRestart({ registry: ctx.registry, requestId });
    jsonResponse(res, 200, { requestId, status: plan?.status ?? 'not-found' });
    return true;
  }

  return false;
};

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
