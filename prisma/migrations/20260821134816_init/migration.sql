-- CreateEnum
CREATE TYPE "OrganizationRole" AS ENUM ('OWNER', 'ADMIN', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('RECHARGE');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('CONNECTED', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "AutomationMode" AS ENUM ('OFF', 'DRY_RUN', 'LIVE');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('SUBSCRIPTION_PRODUCT', 'FULFILMENT_MARKER', 'GIFT_PRODUCT');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED', 'EXPIRED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MappingStatus" AS ENUM ('MAPPED', 'UNMAPPED');

-- CreateEnum
CREATE TYPE "AutomationOverride" AS ENUM ('ENABLED', 'DISABLED');

-- CreateEnum
CREATE TYPE "JourneyEndReason" AS ENUM ('PROGRAM_CHANGE', 'CANCELLED', 'EXPIRED', 'UNMAPPED', 'MANUAL');

-- CreateEnum
CREATE TYPE "CycleSource" AS ENUM ('WEBHOOK', 'BACKFILL', 'MANUAL');

-- CreateEnum
CREATE TYPE "OrderKind" AS ENUM ('CHECKOUT', 'RECURRING');

-- CreateEnum
CREATE TYPE "RuleTriggerType" AS ENUM ('SUBSCRIPTION_CYCLE');

-- CreateEnum
CREATE TYPE "RuleActionType" AS ENUM ('ADD_FULFILLMENT_MARKER');

-- CreateEnum
CREATE TYPE "ExistingSubscriptionPolicy" AS ENUM ('FUTURE_ONLY', 'INCLUDE_EXISTING');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('ADD_FULFILLMENT_MARKER');

-- CreateEnum
CREATE TYPE "ActionSource" AS ENUM ('RULE', 'MANUAL', 'BACKFILL');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('PLANNED', 'EXECUTING', 'ATTACHED', 'FULFILLED', 'FAILED', 'CANCELLED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "IntegrationEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "ExceptionSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('OPEN', 'RESOLVED', 'IGNORED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'INTEGRATION');

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('ORGANIZATION', 'USER', 'INTEGRATION', 'PRODUCT', 'PROGRAM', 'FULFILLMENT_MARKER', 'SUBSCRIPTION', 'JOURNEY', 'RULE', 'ACTION', 'EXCEPTION', 'EVENT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "activeOrganizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/London',
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "markerLeadHours" INTEGER NOT NULL DEFAULT 72,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMembership" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrganizationRole" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'CONNECTED',
    "externalStoreId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "encryptedCredentials" TEXT NOT NULL,
    "credentialsKeyId" TEXT NOT NULL DEFAULT 'v1',
    "automationMode" "AutomationMode" NOT NULL DEFAULT 'OFF',
    "settingsJson" JSONB,
    "capabilitiesJson" JSONB,
    "capabilitiesCheckedAt" TIMESTAMP(3),
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "externalCustomerId" TEXT NOT NULL,
    "email" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "externalProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "ProductType" NOT NULL DEFAULT 'SUBSCRIPTION_PRODUCT',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "externalVariantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "price" DECIMAL(10,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionProgram" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionProgramProduct" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "variantScope" TEXT NOT NULL DEFAULT '*',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionProgramProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FulfillmentMarker" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "variantId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FulfillmentMarker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "customerId" TEXT,
    "externalSubscriptionId" TEXT NOT NULL,
    "externalCustomerId" TEXT NOT NULL,
    "externalAddressId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'UNKNOWN',
    "externalStatus" TEXT,
    "mappingStatus" "MappingStatus" NOT NULL DEFAULT 'UNMAPPED',
    "productId" TEXT,
    "variantId" TEXT,
    "externalProductId" TEXT NOT NULL,
    "externalVariantId" TEXT NOT NULL,
    "productTitleSnapshot" TEXT NOT NULL,
    "variantTitleSnapshot" TEXT,
    "skuSnapshot" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "price" DECIMAL(10,2),
    "intervalUnit" TEXT,
    "intervalFrequency" INTEGER,
    "nextChargeDate" TEXT,
    "nextChargeAt" TIMESTAMP(3),
    "externalCreatedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "automationOverride" "AutomationOverride",
    "currentJourneyId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionJourney" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "externalProductId" TEXT NOT NULL,
    "externalVariantId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endReason" "JourneyEndReason",
    "successfulCycles" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionJourney_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JourneyCycle" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "cycleNumber" INTEGER NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "externalChargeId" TEXT,
    "orderKind" "OrderKind" NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "source" "CycleSource" NOT NULL,
    "sourceEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JourneyCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "triggerType" "RuleTriggerType" NOT NULL DEFAULT 'SUBSCRIPTION_CYCLE',
    "programId" TEXT NOT NULL,
    "cycleNumber" INTEGER NOT NULL,
    "actionType" "RuleActionType" NOT NULL DEFAULT 'ADD_FULFILLMENT_MARKER',
    "fulfillmentMarkerId" TEXT NOT NULL,
    "existingPolicy" "ExistingSubscriptionPolicy" NOT NULL DEFAULT 'FUTURE_ONLY',
    "activatedAt" TIMESTAMP(3),
    "lastTriggeredAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationAction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "ruleId" TEXT,
    "subscriptionId" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "fulfillmentMarkerId" TEXT NOT NULL,
    "type" "ActionType" NOT NULL DEFAULT 'ADD_FULFILLMENT_MARKER',
    "source" "ActionSource" NOT NULL DEFAULT 'RULE',
    "targetCycle" INTEGER NOT NULL,
    "status" "ActionStatus" NOT NULL DEFAULT 'PLANNED',
    "liveKey" TEXT,
    "targetChargeDate" TEXT,
    "targetChargeAt" TIMESTAMP(3),
    "executeAfter" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "externalObjectType" TEXT,
    "externalObjectId" TEXT,
    "externalChargeDate" TEXT,
    "externalAddressId" TEXT,
    "fulfilledByCycleId" TEXT,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "triggeredByEventId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "eventType" TEXT NOT NULL,
    "externalEventId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "headersJson" JSONB,
    "signatureValid" BOOLEAN NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "status" "IntegrationEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "IntegrationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Exception" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "severity" "ExceptionSeverity" NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "autoResolved" BOOLEAN NOT NULL DEFAULT false,
    "integrationId" TEXT,
    "subscriptionId" TEXT,
    "journeyId" TEXT,
    "ruleId" TEXT,
    "actionId" TEXT,
    "metadataJson" JSONB,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,

    CONSTRAINT "Exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "eventType" TEXT NOT NULL,
    "entityType" "EntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON "Account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "OrganizationMembership_userId_idx" ON "OrganizationMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_organizationId_userId_key" ON "OrganizationMembership"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "Integration_organizationId_idx" ON "Integration"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_organizationId_provider_externalStoreId_key" ON "Integration"("organizationId", "provider", "externalStoreId");

-- CreateIndex
CREATE INDEX "Customer_organizationId_email_idx" ON "Customer"("organizationId", "email");

-- CreateIndex
CREATE INDEX "Customer_organizationId_lastName_firstName_idx" ON "Customer"("organizationId", "lastName", "firstName");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_integrationId_externalCustomerId_key" ON "Customer"("integrationId", "externalCustomerId");

-- CreateIndex
CREATE INDEX "Product_organizationId_type_active_idx" ON "Product"("organizationId", "type", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Product_integrationId_externalProductId_key" ON "Product"("integrationId", "externalProductId");

-- CreateIndex
CREATE INDEX "ProductVariant_organizationId_sku_idx" ON "ProductVariant"("organizationId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_productId_externalVariantId_key" ON "ProductVariant"("productId", "externalVariantId");

-- CreateIndex
CREATE INDEX "SubscriptionProgram_organizationId_active_idx" ON "SubscriptionProgram"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionProgram_organizationId_name_key" ON "SubscriptionProgram"("organizationId", "name");

-- CreateIndex
CREATE INDEX "SubscriptionProgramProduct_programId_idx" ON "SubscriptionProgramProduct"("programId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionProgramProduct_organizationId_productId_variant_key" ON "SubscriptionProgramProduct"("organizationId", "productId", "variantScope");

-- CreateIndex
CREATE INDEX "FulfillmentMarker_organizationId_active_idx" ON "FulfillmentMarker"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "FulfillmentMarker_organizationId_name_key" ON "FulfillmentMarker"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_currentJourneyId_key" ON "Subscription"("currentJourneyId");

-- CreateIndex
CREATE INDEX "Subscription_organizationId_status_idx" ON "Subscription"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Subscription_organizationId_mappingStatus_idx" ON "Subscription"("organizationId", "mappingStatus");

-- CreateIndex
CREATE INDEX "Subscription_organizationId_nextChargeAt_idx" ON "Subscription"("organizationId", "nextChargeAt");

-- CreateIndex
CREATE INDEX "Subscription_customerId_idx" ON "Subscription"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_integrationId_externalSubscriptionId_key" ON "Subscription"("integrationId", "externalSubscriptionId");

-- CreateIndex
CREATE INDEX "SubscriptionJourney_organizationId_programId_idx" ON "SubscriptionJourney"("organizationId", "programId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionJourney_subscriptionId_sequence_key" ON "SubscriptionJourney"("subscriptionId", "sequence");

-- CreateIndex
CREATE INDEX "JourneyCycle_organizationId_processedAt_idx" ON "JourneyCycle"("organizationId", "processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "JourneyCycle_journeyId_externalOrderId_key" ON "JourneyCycle"("journeyId", "externalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "JourneyCycle_journeyId_cycleNumber_key" ON "JourneyCycle"("journeyId", "cycleNumber");

-- CreateIndex
CREATE INDEX "AutomationRule_organizationId_enabled_programId_cycleNumber_idx" ON "AutomationRule"("organizationId", "enabled", "programId", "cycleNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRule_organizationId_name_key" ON "AutomationRule"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationAction_liveKey_key" ON "AutomationAction"("liveKey");

-- CreateIndex
CREATE INDEX "AutomationAction_organizationId_status_targetChargeAt_idx" ON "AutomationAction"("organizationId", "status", "targetChargeAt");

-- CreateIndex
CREATE INDEX "AutomationAction_status_executeAfter_idx" ON "AutomationAction"("status", "executeAfter");

-- CreateIndex
CREATE INDEX "AutomationAction_subscriptionId_idx" ON "AutomationAction"("subscriptionId");

-- CreateIndex
CREATE INDEX "IntegrationEvent_status_receivedAt_idx" ON "IntegrationEvent"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "IntegrationEvent_organizationId_receivedAt_idx" ON "IntegrationEvent"("organizationId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationEvent_integrationId_dedupeKey_key" ON "IntegrationEvent"("integrationId", "dedupeKey");

-- CreateIndex
CREATE INDEX "Exception_organizationId_status_severity_idx" ON "Exception"("organizationId", "status", "severity");

-- CreateIndex
CREATE INDEX "Exception_organizationId_detectedAt_idx" ON "Exception"("organizationId", "detectedAt");

-- CreateIndex
CREATE INDEX "ActivityLog_organizationId_createdAt_idx" ON "ActivityLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_entityType_entityId_idx" ON "ActivityLog"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionProgram" ADD CONSTRAINT "SubscriptionProgram_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionProgramProduct" ADD CONSTRAINT "SubscriptionProgramProduct_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionProgramProduct" ADD CONSTRAINT "SubscriptionProgramProduct_programId_fkey" FOREIGN KEY ("programId") REFERENCES "SubscriptionProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionProgramProduct" ADD CONSTRAINT "SubscriptionProgramProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionProgramProduct" ADD CONSTRAINT "SubscriptionProgramProduct_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentMarker" ADD CONSTRAINT "FulfillmentMarker_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentMarker" ADD CONSTRAINT "FulfillmentMarker_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_currentJourneyId_fkey" FOREIGN KEY ("currentJourneyId") REFERENCES "SubscriptionJourney"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionJourney" ADD CONSTRAINT "SubscriptionJourney_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionJourney" ADD CONSTRAINT "SubscriptionJourney_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionJourney" ADD CONSTRAINT "SubscriptionJourney_programId_fkey" FOREIGN KEY ("programId") REFERENCES "SubscriptionProgram"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionJourney" ADD CONSTRAINT "SubscriptionJourney_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionJourney" ADD CONSTRAINT "SubscriptionJourney_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyCycle" ADD CONSTRAINT "JourneyCycle_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyCycle" ADD CONSTRAINT "JourneyCycle_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "SubscriptionJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyCycle" ADD CONSTRAINT "JourneyCycle_sourceEventId_fkey" FOREIGN KEY ("sourceEventId") REFERENCES "IntegrationEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_programId_fkey" FOREIGN KEY ("programId") REFERENCES "SubscriptionProgram"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_fulfillmentMarkerId_fkey" FOREIGN KEY ("fulfillmentMarkerId") REFERENCES "FulfillmentMarker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationAction" ADD CONSTRAINT "AutomationAction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationAction" ADD CONSTRAINT "AutomationAction_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationAction" ADD CONSTRAINT "AutomationAction_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationAction" ADD CONSTRAINT "AutomationAction_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationAction" ADD CONSTRAINT "AutomationAction_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "SubscriptionJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationAction" ADD CONSTRAINT "AutomationAction_fulfillmentMarkerId_fkey" FOREIGN KEY ("fulfillmentMarkerId") REFERENCES "FulfillmentMarker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationAction" ADD CONSTRAINT "AutomationAction_fulfilledByCycleId_fkey" FOREIGN KEY ("fulfilledByCycleId") REFERENCES "JourneyCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationAction" ADD CONSTRAINT "AutomationAction_triggeredByEventId_fkey" FOREIGN KEY ("triggeredByEventId") REFERENCES "IntegrationEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationEvent" ADD CONSTRAINT "IntegrationEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationEvent" ADD CONSTRAINT "IntegrationEvent_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "SubscriptionJourney"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "AutomationAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
