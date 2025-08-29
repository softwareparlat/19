import { Request, Response } from "express";
import { MercadoPagoConfig, Preference } from "mercadopago";
import { db } from "./db";
import { mercadoPagoConfig as mercadoPagoConfigTable } from "@shared/schema";
import { desc, eq } from "drizzle-orm";

// Initialize MercadoPago client
let mercadoPago: MercadoPagoConfig | null = null;

export interface MercadoPagoConfigInterface {
  accessToken: string;
  publicKey: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  isProduction: boolean;
}

let cachedConfig: MercadoPagoConfigInterface | null = null;

export const loadMercadoPagoConfig = async (): Promise<MercadoPagoConfigInterface> => {
  try {
    const [config] = await db
      .select()
      .from(mercadoPagoConfigTable)
      .orderBy(desc(mercadoPagoConfigTable.updatedAt))
      .limit(1);

    if (config) {
      cachedConfig = {
        accessToken: config.accessToken || "",
        publicKey: config.publicKey || "",
        clientId: config.clientId || "",
        clientSecret: config.clientSecret || "",
        webhookSecret: config.webhookSecret || "",
        isProduction: config.isProduction || false,
      };
    } else {
      // Fallback to env variables if no DB config
      cachedConfig = {
        accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN || "",
        publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY || "",
        clientId: process.env.MERCADO_PAGO_CLIENT_ID || "",
        clientSecret: process.env.MERCADO_PAGO_CLIENT_SECRET || "",
        webhookSecret: process.env.MERCADO_PAGO_WEBHOOK_SECRET || "",
        isProduction: false,
      };
    }

    return cachedConfig;
  } catch (error) {
    console.error("Error loading MercadoPago config from DB:", error);
    
    // Fallback to env variables
    return {
      accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN || "",
      publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY || "",
      clientId: process.env.MERCADO_PAGO_CLIENT_ID || "",
      clientSecret: process.env.MERCADO_PAGO_CLIENT_SECRET || "",
      webhookSecret: process.env.MERCADO_PAGO_WEBHOOK_SECRET || "",
      isProduction: false,
    };
  }
};

export const updateMercadoPagoConfig = async (config: Partial<MercadoPagoConfigInterface>): Promise<void> => {
  try {
    // Check if a config row exists
    const [existingConfig] = await db
      .select()
      .from(mercadoPagoConfigTable)
      .limit(1);

    if (existingConfig) {
      // Update existing config
      await db
        .update(mercadoPagoConfigTable)
        .set({
          ...config,
          updatedAt: new Date(),
        })
        .where(eq(mercadoPagoConfigTable.id, existingConfig.id));
    } else {
      // Insert new config if none exists
      await db
        .insert(mercadoPagoConfigTable)
        .values({
          ...config,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
    }

    // Refresh cached config
    cachedConfig = null;
    await loadMercadoPagoConfig();
    
    // Reset MercadoPago client to use new config
    mercadoPago = null;
  } catch (error) {
    console.error("Error updating MercadoPago config:", error);
    throw error;
  }
};

export const getMercadoPagoConfig = async (): Promise<MercadoPagoConfigInterface> => {
  if (!cachedConfig) {
    await loadMercadoPagoConfig();
  }
  return cachedConfig!;
};

export interface CreatePaymentData {
  amount: number;
  description: string;
  projectId: number;
  clientEmail: string;
  clientName: string;
}

export const createPayment = async (data: CreatePaymentData): Promise<any> => {
  try {
    // Load latest config from database
    const config = await getMercadoPagoConfig();
    
    // Initialize MercadoPago if not already done or config changed
    if (!mercadoPago && config.accessToken) {
      mercadoPago = new MercadoPagoConfig({
        accessToken: config.accessToken,
      });
    }

    if (!mercadoPago) {
      throw new Error("MercadoPago no configurado. Configurar access token en el panel admin.");
    }

    const preference = new Preference(mercadoPago);

    const preferenceData = {
      items: [
        {
          title: data.description,
          unit_price: data.amount,
          quantity: 1,
        },
      ],
      payer: {
        email: data.clientEmail,
        name: data.clientName,
      },
      back_urls: {
        success: `${process.env.FRONTEND_URL || 'http://localhost:5000'}/payment/success`,
        failure: `${process.env.FRONTEND_URL || 'http://localhost:5000'}/payment/failure`,
        pending: `${process.env.FRONTEND_URL || 'http://localhost:5000'}/payment/pending`,
      },
      auto_return: "approved" as const,
      external_reference: data.projectId.toString(),
      notification_url: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/payments/webhook`,
    };

    const response = await preference.create({ body: preferenceData });

    return {
      id: response.id,
      init_point: response.init_point,
      sandbox_init_point: response.sandbox_init_point,
    };
  } catch (error) {
    console.error("Error creating MercadoPago payment:", error);
    
    // Fallback to mock if MercadoPago fails (for development)
    if (process.env.NODE_ENV === 'development') {
      console.warn("Using mock payment link for development");
      return {
        id: `mock-payment-${Date.now()}`,
        init_point: `https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=mock-${data.projectId}`,
        sandbox_init_point: `https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=mock-${data.projectId}`,
      };
    }
    
    throw new Error("Error al crear el pago");
  }
};

export const handleWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const { type, data } = req.body;
    console.log("MercadoPago webhook received:", { type, data });

    if (type === "payment") {
      // Load latest config from database
      const config = await getMercadoPagoConfig();
      
      // Initialize MercadoPago if not already done
      if (!mercadoPago && config.accessToken) {
        mercadoPago = new MercadoPagoConfig({
          accessToken: config.accessToken,
        });
      }

      if (mercadoPago && data.id) {
        try {
          // Get payment details from MercadoPago
          const { Payment } = await import('mercadopago');
          const payment = new Payment(mercadoPago);
          const paymentData = await payment.get({ id: data.id });

          console.log("Payment data from MercadoPago:", paymentData);

          // Here you would update your database based on payment status
          if (paymentData.status === 'approved') {
            // Update payment stage status to 'paid'
            // Update project progress if needed
            // Send notification emails
            console.log("Payment approved:", paymentData.id);
          }
        } catch (mpError) {
          console.error("Error fetching payment from MercadoPago:", mpError);
        }
      }
    }

    res.status(200).json({ message: "Webhook processed" });
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).json({ message: "Error processing webhook" });
  }
};

export const validatePayment = async (paymentId: string): Promise<any> => {
  try {
    // In a real implementation, you would validate with MercadoPago API
    // const payment = await mercadopago.payment.findById(paymentId);
    
    // Mock validation for development
    return {
      id: paymentId,
      status: "approved",
      status_detail: "accredited",
      transaction_amount: 5000,
      external_reference: "1",
    };
  } catch (error) {
    console.error("Error validating payment:", error);
    throw new Error("Error al validar el pago");
  }
};
