export const mailer = {
  async send(options: { to: string; subject: string; html: string }): Promise<void> {
    // Integrate provider (Resend, Sendgrid, SES...) here.
    // eslint-disable-next-line no-console
    console.log('Mock mail sent', options.to, options.subject);
  }
};
