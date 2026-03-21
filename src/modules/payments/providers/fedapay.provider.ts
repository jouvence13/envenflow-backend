import { FedaPay, Transaction } from 'fedapay';
import { AppError } from '../../../core/errors/AppError';
import { env } from '../../../config/env';

export type FedapayInitializationInput = {
	amount: number;
	currency: string;
	reference: string;
	callbackUrl: string;
	description: string;
	customer: {
		email: string;
		phoneNumber?: string;
		firstName?: string;
		lastName?: string;
	};
};

export type FedapayInitializationResult = {
	provider: 'FEDAPAY';
	paymentUrl: string;
	providerReference: string;
};

let isConfigured = false;

function configureFedapayClient(): void {
	if (isConfigured) {
		return;
	}

	if (!env.FEDAPAY_SECRET_KEY) {
		throw new AppError(
			'FedaPay secret key is missing. Configure FEDAPAY_SECRET_KEY first.',
			500,
			'PAYMENT_PROVIDER_CONFIG_MISSING'
		);
	}

	FedaPay.setApiKey(env.FEDAPAY_SECRET_KEY);
	FedaPay.setEnvironment(env.FEDAPAY_ENV);

	if (env.FEDAPAY_ACCOUNT_ID) {
		const asNumber = Number(env.FEDAPAY_ACCOUNT_ID);
		FedaPay.setAccountId(Number.isFinite(asNumber) ? asNumber : env.FEDAPAY_ACCOUNT_ID);
	}

	isConfigured = true;
}

function normalizeName(value: string | undefined, fallback: string): string {
	const normalized = (value || '').trim();
	return normalized.length > 0 ? normalized : fallback;
}

export async function initializeFedapayPayment(
	input: FedapayInitializationInput
): Promise<FedapayInitializationResult> {
	configureFedapayClient();

	const normalizedAmount = Math.round(Number(input.amount || 0));

	if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
		throw new AppError('Invalid FedaPay amount', 422, 'PAYMENT_PROVIDER_INVALID_AMOUNT');
	}

	const payload = {
		amount: normalizedAmount,
		description: input.description,
		callback_url: input.callbackUrl,
		reference: input.reference,
		currency: {
			iso: (input.currency || 'XOF').toUpperCase()
		},
		customer: {
			email: input.customer.email,
			firstname: normalizeName(input.customer.firstName, 'Client'),
			lastname: normalizeName(input.customer.lastName, 'Evenflow')
		}
	};

	try {
		const transaction = await Transaction.create(payload);
		const tokenObject = await transaction.generateToken();
		const token = String(tokenObject?.token || '');
		const paymentUrl = String(tokenObject?.url || (token ? `https://process.fedapay.com/${token}` : ''));

		if (!paymentUrl) {
			throw new AppError('FedaPay did not return a payment URL', 502, 'PAYMENT_PROVIDER_ERROR');
		}

		const providerReference = String(transaction?.id || transaction?.reference || input.reference);

		return {
			provider: 'FEDAPAY',
			paymentUrl,
			providerReference
		};
	} catch (error) {
		const message =
			error instanceof Error && error.message
				? error.message
				: 'Unknown FedaPay initialization error';

		throw new AppError(`FedaPay initialization failed: ${message}`, 502, 'PAYMENT_PROVIDER_ERROR');
	}
}

