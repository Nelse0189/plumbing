import type { CSSProperties } from 'react';
import type { JobTicket, JobTicketMaterial } from '../types';
import {
  HEATERS_WO_EXTRA_NOTES,
  HEATERS_WO_FIELDS,
  clampWoFontSize,
  extraNotesValue,
  formatTicketDate,
  parseTicketDate,
  pdfBoxStyle,
  workOrderFormImage,
  type PdfBox,
} from '../utils/heatersWorkOrder';

interface HeatersWorkOrderFormProps {
  ticket: Omit<JobTicket, 'id'> & { id?: string };
  suggestedTotal: string;
  readOnly?: boolean;
  customerSign?: boolean;
  signable?: boolean;
  onChange: <K extends keyof JobTicket>(key: K, value: JobTicket[K]) => void;
  onMaterialChange: (index: number, field: keyof JobTicketMaterial, value: string) => void;
  onExtraChange: (index: number, field: keyof JobTicketMaterial, value: string) => void;
  onExtraNotesChange: (value: string) => void;
  onRequestSign?: (field: 'customerSignature' | 'customerInitial') => void;
}

function OverlayField({
  box,
  value,
  onChange,
  readOnly,
  multiline,
  type = 'text',
  placeholder,
  className = '',
}: {
  box: PdfBox;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  multiline?: boolean;
  type?: string;
  placeholder?: string;
  className?: string;
}) {
  const style = pdfBoxStyle(box);
  const shared = {
    className: `heaters-wo__field ${className}`.trim(),
    style,
    value,
    readOnly,
    placeholder,
    tabIndex: readOnly ? -1 : 0,
  };
  if (multiline) {
    return (
      <textarea
        {...shared}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <input
      {...shared}
      type={type}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export default function HeatersWorkOrderForm({
  ticket,
  suggestedTotal,
  readOnly,
  customerSign,
  signable,
  onChange,
  onMaterialChange,
  onExtraChange,
  onExtraNotesChange,
  onRequestSign,
}: HeatersWorkOrderFormProps) {
  const fieldsLocked = Boolean(readOnly && !customerSign);
  const customerOnly = Boolean(customerSign);
  const canSign = Boolean(signable || customerSign) && ticket.status !== 'signed';

  const fontSize = clampWoFontSize(ticket.pdfFontSize);

  return (
    <div
      className="heaters-wo"
      style={{ '--wo-font-size': `${fontSize}px` } as CSSProperties}
    >
      <img
        src={workOrderFormImage(ticket.formTemplate)}
        alt={ticket.formTemplate === 'heaters' ? '1 800 Heaters work order' : 'N&J Plumbing work order'}
        className="heaters-wo__page"
        draggable={false}
      />
      <div className="heaters-wo__fields">
        <OverlayField
          box={HEATERS_WO_FIELDS.customerName}
          value={ticket.customerName}
          onChange={(value) => onChange('customerName', value)}
          readOnly={fieldsLocked || customerOnly}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.street}
          value={ticket.street}
          onChange={(value) => onChange('street', value)}
          readOnly={fieldsLocked || customerOnly}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.city}
          value={ticket.city}
          onChange={(value) => onChange('city', value)}
          readOnly={fieldsLocked || customerOnly}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.zip}
          value={ticket.zip}
          onChange={(value) => onChange('zip', value)}
          readOnly={fieldsLocked || customerOnly}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.phone}
          value={ticket.phone}
          onChange={(value) => onChange('phone', value)}
          readOnly={fieldsLocked || customerOnly}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.workOrderNumber}
          value={ticket.workOrderNumber}
          onChange={(value) => onChange('workOrderNumber', value)}
          readOnly={fieldsLocked || customerOnly}
          placeholder="WO #"
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.followUpNotes}
          value={ticket.followUpNotes}
          onChange={(value) => onChange('followUpNotes', value)}
          readOnly={fieldsLocked || customerOnly}
          multiline
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.serviceDate}
          value={formatTicketDate(ticket.serviceDate)}
          onChange={(value) => onChange('serviceDate', parseTicketDate(value))}
          readOnly={fieldsLocked || customerOnly}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.plumberName}
          value={ticket.plumberName}
          onChange={(value) => onChange('plumberName', value)}
          readOnly={fieldsLocked || customerOnly}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.heaterModel}
          value={ticket.heaterModel}
          onChange={(value) => onChange('heaterModel', value)}
          readOnly={fieldsLocked || customerOnly}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.heaterPrice}
          value={ticket.heaterPrice}
          onChange={(value) => onChange('heaterPrice', value)}
          readOnly={fieldsLocked || customerOnly}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.serialNumber}
          value={ticket.serialNumber}
          onChange={(value) => onChange('serialNumber', value)}
          readOnly={fieldsLocked || customerOnly}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.heaterLocation}
          value={ticket.heaterLocation}
          onChange={(value) => onChange('heaterLocation', value)}
          readOnly={fieldsLocked || customerOnly}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.tankWarrantyYears}
          value={ticket.tankWarrantyYears}
          onChange={(value) => onChange('tankWarrantyYears', value)}
          readOnly={fieldsLocked || customerOnly}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.dwellingType}
          value={ticket.dwellingType}
          onChange={(value) => onChange('dwellingType', value)}
          readOnly={fieldsLocked || customerOnly}
        />
        {HEATERS_WO_FIELDS.additional.map((box, index) => (
          <OverlayField
            key={`item-${index}`}
            box={box}
            value={ticket.materials[index]?.description || ''}
            onChange={(value) => onMaterialChange(index, 'description', value)}
            readOnly={fieldsLocked || customerOnly}
          />
        ))}
        {HEATERS_WO_FIELDS.additionalPrice.map((box, index) => (
          <OverlayField
            key={`item-price-${index}`}
            box={box}
            value={ticket.materials[index]?.amount || ''}
            onChange={(value) => onMaterialChange(index, 'amount', value)}
            readOnly={fieldsLocked || customerOnly}
          />
        ))}
        <OverlayField
          box={HEATERS_WO_FIELDS.permitAmount}
          value={ticket.permitAmount}
          onChange={(value) => onChange('permitAmount', value)}
          readOnly={fieldsLocked || customerOnly}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.totalAmount}
          value={ticket.totalAmount}
          placeholder={suggestedTotal}
          onChange={(value) => onChange('totalAmount', value)}
          readOnly={fieldsLocked || customerOnly}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.paymentMethod}
          value={ticket.paymentMethod}
          onChange={(value) => onChange('paymentMethod', value)}
          readOnly={fieldsLocked}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.driversLicense}
          value={ticket.driversLicense}
          onChange={(value) => onChange('driversLicense', value)}
          readOnly={fieldsLocked}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.cardOrCheckNumber}
          value={ticket.cardOrCheckNumber}
          onChange={(value) => onChange('cardOrCheckNumber', value)}
          readOnly={fieldsLocked}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.routingNumber}
          value={ticket.routingNumber}
          onChange={(value) => onChange('routingNumber', value)}
          readOnly={fieldsLocked}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.cardExp}
          value={ticket.cardExp}
          onChange={(value) => onChange('cardExp', value)}
          readOnly={fieldsLocked}
        />
        <OverlayField
          box={HEATERS_WO_FIELDS.amountPaid}
          value={ticket.amountPaid}
          onChange={(value) => onChange('amountPaid', value)}
          readOnly={fieldsLocked}
        />
        <div className="heaters-wo__extra-notes" style={pdfBoxStyle(HEATERS_WO_EXTRA_NOTES)}>
          <textarea
            className="heaters-wo__field heaters-wo__field--lined"
            value={extraNotesValue(ticket.extraCharges)}
            onChange={(event) => onExtraNotesChange(event.target.value)}
            readOnly={fieldsLocked || customerOnly}
            tabIndex={fieldsLocked || customerOnly ? -1 : 0}
            aria-label="Recommended work"
          />
        </div>
        {HEATERS_WO_FIELDS.extraPrice.map((box, index) => (
          <OverlayField
            key={`extra-price-${index}`}
            box={box}
            className="heaters-wo__field--price"
            value={ticket.extraCharges?.[index]?.amount || ''}
            onChange={(value) => onExtraChange(index, 'amount', value)}
            readOnly={fieldsLocked || customerOnly}
          />
        ))}
        <button
          type="button"
          className={`heaters-wo__sign ${canSign ? 'heaters-wo__sign--live' : ''}`}
          style={pdfBoxStyle(HEATERS_WO_FIELDS.customerSignature)}
          disabled={!canSign}
          onClick={() => canSign && onRequestSign?.('customerSignature')}
          aria-label={canSign ? 'Sign with finger' : 'Customer signature'}
        >
          {ticket.customerSignature ? (
            <img src={ticket.customerSignature} alt="Customer signature" />
          ) : canSign ? (
            <span>Tap to sign</span>
          ) : null}
        </button>
        <button
          type="button"
          className={`heaters-wo__initial ${canSign ? 'heaters-wo__sign--live' : ''}`}
          style={pdfBoxStyle(HEATERS_WO_FIELDS.customerInitial)}
          disabled={!canSign}
          onClick={() => canSign && onRequestSign?.('customerInitial')}
          aria-label={canSign ? 'Initial with finger' : 'Customer initial'}
        >
          {ticket.customerInitial ? (
            <img src={ticket.customerInitial} alt="Customer initial" />
          ) : canSign ? (
            <span>Tap</span>
          ) : null}
        </button>
      </div>
    </div>
  );
}
