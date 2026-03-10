export type PaymentInitializationResult = {
  provider: 'KKIAPAY' | 'FEDAPAY' | 'STRIPE';
  paymentUrl: string;
  providerReference: string;
};

export const paymentGateway = {
  async initialize(input: {
    provider: 'KKIAPAY' | 'FEDAPAY' | 'STRIPE';
    amount: number;
    currency: string;
    reference: string;
  }): Promise<PaymentInitializationResult> {
    return {
      provider: input.provider,
      paymentUrl: `https://pay.example.com/${input.reference}`,
      providerReference: `${input.provider}-${Date.now()}`
    };
  }
};
