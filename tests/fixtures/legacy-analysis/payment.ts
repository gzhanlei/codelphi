interface PaymentGateway {
  charge(amountCents: number): Promise<string>;
}

export async function chargePayment(loadGateway: () => Promise<PaymentGateway>, amountCents: number) {
  const gateway = await loadGateway();
  return gateway.charge(amountCents);
}
