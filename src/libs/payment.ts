import { AppError } from '../core/errors/AppError';
import { initializeFedapayPayment } from '../modules/payments/providers/fedapay.provider';

export type SupportedPaymentProvider = 'KKIAPAY' | 'FEDAPAY' | 'STRIPE';

export type PaymentInitializationResult = {
  provider: SupportedPaymentProvider;
  paymentUrl: string;
  providerReference: string;
};

export type PaymentInitializationInput = {
  provider: SupportedPaymentProvider;
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

export const paymentGateway = {
  async initialize(input: PaymentInitializationInput): Promise<PaymentInitializationResult> {
    if (input.provider === 'FEDAPAY') {
      return initializeFedapayPayment(input);
    }

    if (input.provider === 'KKIAPAY' || input.provider === 'STRIPE') {
      // Temporary fallback for providers not yet wired to live SDKs.
      return {
        provider: input.provider,
        paymentUrl: `https://pay.example.com/${input.reference}`,
        providerReference: `${input.provider}-${Date.now()}`
      };
    }

    throw new AppError('Unsupported payment provider', 422, 'PAYMENT_PROVIDER_UNSUPPORTED');
  }
};
