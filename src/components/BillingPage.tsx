import { useMemo, useState, type CSSProperties } from 'react';
import type { Stop, Truck, WorkOrder, WorkOrderLineItem } from '../types';
import {
  LINE_CATEGORIES,
  buildBillingOrder,
  downloadBillingOrderExcel,
  formatCurrency,
  lineAmount,
  nextDocumentNumber,
  workOrderSubtotal,
} from '../services/billingExcelService';

interface BillingPageProps {
  trucks: Truck[];
  selectedDate: string;
}

interface StopCandidate {
  stop: Stop;
  truckName: string;
  technician?: string;
}

const DEFAULT_TAX_RATE = 6.625;
const DEFAULT_BILLING_NOTES = 'Payment due upon receipt.';

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function emptyLineItem(): WorkOrderLineItem {
  return {
    id: newId('line'),
    description: '',
    category: 'labor',
    quantity: 1,
    unitPrice: 0,
  };
}

function workOrderFromStop(
  candidate: StopCandidate,
  date: string,
  existingNumbers: string[],
): WorkOrder {
  const jobDescription = candidate.stop.notes?.trim()
    || candidate.stop.callSummary?.trim()
    || 'Plumbing service';

  return {
    id: newId('wo'),
    workOrderNumber: nextDocumentNumber('WO', date, existingNumbers),
    date,
    customerName: candidate.stop.customerName,
    address: candidate.stop.address,
    phone: candidate.stop.phone,
    truckName: candidate.truckName,
    technician: candidate.technician,
    jobDescription,
    notes: '',
    sourceStopId: candidate.stop.id,
    lineItems: [
      {
        id: newId('line'),
        description: jobDescription,
        category: 'labor',
        quantity: 1,
        unitPrice: 0,
      },
    ],
    status: 'draft',
  };
}

export default function BillingPage({ trucks, selectedDate }: BillingPageProps) {
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [taxRate, setTaxRate] = useState(DEFAULT_TAX_RATE);
  const [billingNotes, setBillingNotes] = useState(DEFAULT_BILLING_NOTES);
  const [issuedBillingNumbers, setIssuedBillingNumbers] = useState<string[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualOrder, setManualOrder] = useState({
    customerName: '',
    address: '',
    phone: '',
    truckName: '',
    technician: '',
    jobDescription: '',
    notes: '',
  });

  const scheduledStops = useMemo<StopCandidate[]>(() => {
    return trucks.flatMap((truck) =>
      truck.stops.map((stop) => ({
        stop,
        truckName: truck.name,
        technician: truck.driver,
      })),
    );
  }, [trucks]);

  const importedStopIds = useMemo(() => {
    return new Set(workOrders.map((order) => order.sourceStopId).filter(Boolean));
  }, [workOrders]);

  const selectedWorkOrders = workOrders.filter((order) => selectedIds.includes(order.id));
  const billingPreview = selectedWorkOrders.length > 0
    ? buildBillingOrder(selectedWorkOrders, taxRate, billingNotes, issuedBillingNumbers)
    : null;
  const mixedCustomers = selectedWorkOrders.some(
    (order) => order.customerName !== selectedWorkOrders[0]?.customerName,
  );

  const addWorkOrder = (order: WorkOrder) => {
    setWorkOrders((current) => [...current, order]);
    setSelectedIds((current) => [...current, order.id]);
  };

  const handleImportStop = (candidate: StopCandidate) => {
    const existingNumbers = workOrders.map((order) => order.workOrderNumber);
    addWorkOrder(workOrderFromStop(candidate, selectedDate, existingNumbers));
  };

  const handleImportAllStops = () => {
    const remaining = scheduledStops.filter((candidate) => !importedStopIds.has(candidate.stop.id));
    if (remaining.length === 0) return;

    const created: WorkOrder[] = [];
    const existingNumbers = workOrders.map((order) => order.workOrderNumber);
    for (const candidate of remaining) {
      const order = workOrderFromStop(
        candidate,
        selectedDate,
        [...existingNumbers, ...created.map((item) => item.workOrderNumber)],
      );
      created.push(order);
    }
    setWorkOrders((current) => [...current, ...created]);
    setSelectedIds((current) => [...current, ...created.map((order) => order.id)]);
  };

  const handleAddManualWorkOrder = () => {
    if (!manualOrder.customerName.trim() || !manualOrder.address.trim()) {
      alert('Please enter a customer name and address.');
      return;
    }

    const order: WorkOrder = {
      id: newId('wo'),
      workOrderNumber: nextDocumentNumber(
        'WO',
        selectedDate,
        workOrders.map((item) => item.workOrderNumber),
      ),
      date: selectedDate,
      customerName: manualOrder.customerName.trim(),
      address: manualOrder.address.trim(),
      phone: manualOrder.phone.trim(),
      truckName: manualOrder.truckName.trim() || undefined,
      technician: manualOrder.technician.trim() || undefined,
      jobDescription: manualOrder.jobDescription.trim() || 'Plumbing service',
      notes: manualOrder.notes.trim(),
      lineItems: [emptyLineItem()],
      status: 'draft',
    };

    addWorkOrder(order);
    setManualOrder({
      customerName: '',
      address: '',
      phone: '',
      truckName: '',
      technician: '',
      jobDescription: '',
      notes: '',
    });
    setShowManualForm(false);
  };

  const updateWorkOrder = (id: string, patch: Partial<WorkOrder>) => {
    setWorkOrders((current) =>
      current.map((order) => (order.id === id ? { ...order, ...patch } : order)),
    );
  };

  const updateLineItem = (workOrderId: string, lineId: string, patch: Partial<WorkOrderLineItem>) => {
    setWorkOrders((current) =>
      current.map((order) => {
        if (order.id !== workOrderId) return order;
        return {
          ...order,
          lineItems: order.lineItems.map((item) =>
            item.id === lineId ? { ...item, ...patch } : item,
          ),
        };
      }),
    );
  };

  const addLineItem = (workOrderId: string) => {
    setWorkOrders((current) =>
      current.map((order) =>
        order.id === workOrderId
          ? { ...order, lineItems: [...order.lineItems, emptyLineItem()] }
          : order,
      ),
    );
  };

  const removeLineItem = (workOrderId: string, lineId: string) => {
    setWorkOrders((current) =>
      current.map((order) =>
        order.id === workOrderId
          ? { ...order, lineItems: order.lineItems.filter((item) => item.id !== lineId) }
          : order,
      ),
    );
  };

  const removeWorkOrder = (id: string) => {
    setWorkOrders((current) => current.filter((order) => order.id !== id));
    setSelectedIds((current) => current.filter((selectedId) => selectedId !== id));
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((selectedId) => selectedId !== id) : [...current, id],
    );
  };

  const handleDownloadExcel = async () => {
    if (!billingPreview || selectedWorkOrders.length === 0) {
      alert('Select at least one work order to create a billing order.');
      return;
    }
    if (selectedWorkOrders.some((order) => order.lineItems.length === 0)) {
      alert('Each selected work order needs at least one line item.');
      return;
    }

    setDownloading(true);
    try {
      await downloadBillingOrderExcel(billingPreview, selectedWorkOrders);
      setIssuedBillingNumbers((current) => [...current, billingPreview.billingOrderNumber]);
      setWorkOrders((current) =>
        current.map((order) =>
          selectedIds.includes(order.id) ? { ...order, status: 'billed' } : order,
        ),
      );
    } catch (error) {
      console.error('Failed to create Excel billing order:', error);
      alert('Failed to create the Excel file. Please try again.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ color: 'var(--accent)', marginBottom: '0.5rem' }}>
          Billing — {selectedDate}
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', maxWidth: '720px' }}>
          Skeleton for work orders to Excel billing. Import jobs from the day&apos;s schedule
          or enter a work order, add labor and material lines, then download a billing order workbook.
        </p>
      </div>

      <section style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <h3 style={{ color: 'var(--text-primary)' }}>1. Scheduled jobs</h3>
          <button
            onClick={handleImportAllStops}
            disabled={scheduledStops.every((candidate) => importedStopIds.has(candidate.stop.id))}
          >
            Import all stops
          </button>
        </div>
        {scheduledStops.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)' }}>
            No stops on this date. Add jobs on the Schedule page, or create a work order below.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {scheduledStops.map((candidate) => {
              const imported = importedStopIds.has(candidate.stop.id);
              return (
                <div key={candidate.stop.id} style={rowCardStyle}>
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      {candidate.stop.time} — {candidate.stop.customerName || 'Unnamed customer'}
                    </div>
                    <div style={mutedStyle}>{candidate.stop.address}</div>
                    <div style={mutedStyle}>
                      {candidate.truckName}
                      {candidate.technician ? ` · ${candidate.technician}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => handleImportStop(candidate)}
                    disabled={imported}
                    style={{
                      backgroundColor: imported ? 'var(--bg-secondary)' : 'var(--accent)',
                      color: imported ? 'var(--text-secondary)' : 'var(--bg-primary)',
                      borderColor: imported ? 'var(--border)' : 'var(--accent)',
                    }}
                  >
                    {imported ? 'Imported' : 'Add as work order'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <h3 style={{ color: 'var(--text-primary)' }}>2. Work orders</h3>
          <button onClick={() => setShowManualForm(!showManualForm)}>
            {showManualForm ? 'Cancel' : '+ New work order'}
          </button>
        </div>

        {showManualForm && (
          <div style={{ ...sectionStyle, marginBottom: '1rem', padding: '1rem' }}>
            <div style={formGridStyle}>
              <input
                type="text"
                placeholder="Customer Name *"
                value={manualOrder.customerName}
                onChange={(e) => setManualOrder({ ...manualOrder, customerName: e.target.value })}
              />
              <input
                type="text"
                placeholder="Address *"
                value={manualOrder.address}
                onChange={(e) => setManualOrder({ ...manualOrder, address: e.target.value })}
              />
              <input
                type="tel"
                placeholder="Phone"
                value={manualOrder.phone}
                onChange={(e) => setManualOrder({ ...manualOrder, phone: e.target.value })}
              />
              <input
                type="text"
                placeholder="Truck"
                value={manualOrder.truckName}
                onChange={(e) => setManualOrder({ ...manualOrder, truckName: e.target.value })}
              />
              <input
                type="text"
                placeholder="Technician"
                value={manualOrder.technician}
                onChange={(e) => setManualOrder({ ...manualOrder, technician: e.target.value })}
              />
              <input
                type="text"
                placeholder="Job description"
                value={manualOrder.jobDescription}
                onChange={(e) => setManualOrder({ ...manualOrder, jobDescription: e.target.value })}
              />
            </div>
            <textarea
              placeholder="Internal notes"
              value={manualOrder.notes}
              onChange={(e) => setManualOrder({ ...manualOrder, notes: e.target.value })}
              style={{ width: '100%', minHeight: '60px', margin: '1rem 0' }}
            />
            <button
              onClick={handleAddManualWorkOrder}
              style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-primary)', borderColor: 'var(--accent)' }}
            >
              Save work order
            </button>
          </div>
        )}

        {workOrders.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)' }}>
            No work orders yet. Import a scheduled stop or add one manually.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {workOrders.map((order) => (
              <article key={order.id} style={sectionStyle}>
                <div style={sectionHeaderStyle}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(order.id)}
                      onChange={() => toggleSelected(order.id)}
                    />
                    <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                      {order.workOrderNumber}
                    </span>
                    <span style={mutedStyle}>{order.status}</span>
                  </label>
                  <button
                    onClick={() => removeWorkOrder(order.id)}
                    style={{ color: 'var(--error)', borderColor: 'var(--error)' }}
                  >
                    Remove
                  </button>
                </div>

                <div style={formGridStyle}>
                  <input
                    type="text"
                    value={order.customerName}
                    onChange={(e) => updateWorkOrder(order.id, { customerName: e.target.value })}
                    placeholder="Customer"
                  />
                  <input
                    type="text"
                    value={order.address}
                    onChange={(e) => updateWorkOrder(order.id, { address: e.target.value })}
                    placeholder="Address"
                  />
                  <input
                    type="tel"
                    value={order.phone}
                    onChange={(e) => updateWorkOrder(order.id, { phone: e.target.value })}
                    placeholder="Phone"
                  />
                  <input
                    type="text"
                    value={order.jobDescription}
                    onChange={(e) => updateWorkOrder(order.id, { jobDescription: e.target.value })}
                    placeholder="Job description"
                  />
                </div>

                <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                    <thead>
                      <tr>
                        {['Description', 'Category', 'Qty', 'Unit price', 'Amount', ''].map((heading) => (
                          <th key={heading} style={tableHeadStyle}>{heading}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {order.lineItems.map((item) => (
                        <tr key={item.id}>
                          <td style={tableCellStyle}>
                            <input
                              type="text"
                              value={item.description}
                              onChange={(e) => updateLineItem(order.id, item.id, { description: e.target.value })}
                              placeholder="Labor / part / trip charge"
                              style={{ width: '100%' }}
                            />
                          </td>
                          <td style={tableCellStyle}>
                            <select
                              value={item.category}
                              onChange={(e) =>
                                updateLineItem(order.id, item.id, {
                                  category: e.target.value as WorkOrderLineItem['category'],
                                })
                              }
                            >
                              {LINE_CATEGORIES.map((category) => (
                                <option key={category} value={category}>
                                  {category}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td style={tableCellStyle}>
                            <input
                              type="number"
                              min="0"
                              step="0.25"
                              value={item.quantity}
                              onChange={(e) =>
                                updateLineItem(order.id, item.id, {
                                  quantity: Number(e.target.value) || 0,
                                })
                              }
                              style={{ width: '5rem' }}
                            />
                          </td>
                          <td style={tableCellStyle}>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={item.unitPrice}
                              onChange={(e) =>
                                updateLineItem(order.id, item.id, {
                                  unitPrice: Number(e.target.value) || 0,
                                })
                              }
                              style={{ width: '7rem' }}
                            />
                          </td>
                          <td style={{ ...tableCellStyle, color: 'var(--accent)' }}>
                            {formatCurrency(lineAmount(item))}
                          </td>
                          <td style={tableCellStyle}>
                            <button
                              onClick={() => removeLineItem(order.id, item.id)}
                              style={{ color: 'var(--error)', borderColor: 'var(--error)', padding: '0.3rem 0.6rem' }}
                            >
                              ×
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.75rem' }}>
                  <button onClick={() => addLineItem(order.id)}>+ Line item</button>
                  <div style={{ color: 'var(--text-secondary)' }}>
                    Work order total: {formatCurrency(workOrderSubtotal(order))}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <h3 style={{ color: 'var(--text-primary)' }}>3. Billing order</h3>
          <button
            onClick={handleDownloadExcel}
            disabled={!billingPreview || downloading}
            style={{
              backgroundColor: billingPreview ? 'var(--accent)' : 'var(--bg-secondary)',
              color: billingPreview ? 'var(--bg-primary)' : 'var(--text-secondary)',
              borderColor: billingPreview ? 'var(--accent)' : 'var(--border)',
            }}
          >
            {downloading ? 'Creating Excel...' : 'Download Excel'}
          </button>
        </div>

        <div style={{ ...formGridStyle, marginBottom: '1rem', maxWidth: '480px' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', fontSize: '0.85rem' }}>
            NJ tax rate (%)
            <input
              type="number"
              min="0"
              step="0.001"
              value={taxRate}
              onChange={(e) => setTaxRate(Number(e.target.value) || 0)}
            />
          </label>
        </div>
        <textarea
          placeholder="Billing notes / payment terms"
          value={billingNotes}
          onChange={(e) => setBillingNotes(e.target.value)}
          style={{ width: '100%', minHeight: '70px', marginBottom: '1rem' }}
        />

        {!billingPreview ? (
          <p style={{ color: 'var(--text-secondary)' }}>
            Select one or more work orders to preview the billing order.
          </p>
        ) : (
          <div>
            {mixedCustomers && (
              <p style={{ color: 'var(--error)', marginBottom: '1rem', fontSize: '0.85rem' }}>
                Selected work orders have different customers. The Excel file will bill the first customer listed.
              </p>
            )}
            <div style={{ marginBottom: '1rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
              <div><strong style={{ color: 'var(--text-primary)' }}>{billingPreview.billingOrderNumber}</strong></div>
              <div>{billingPreview.customerName}</div>
              <div>{billingPreview.address}</div>
              <div>Work orders: {billingPreview.workOrderNumbers.join(', ')}</div>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', marginBottom: '1rem' }}>
              <thead>
                <tr>
                  {['Description', 'Category', 'Qty', 'Unit price', 'Amount'].map((heading) => (
                    <th key={heading} style={tableHeadStyle}>{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {billingPreview.lineItems.map((item) => (
                  <tr key={item.id}>
                    <td style={tableCellStyle}>{item.description || '—'}</td>
                    <td style={tableCellStyle}>{item.category}</td>
                    <td style={tableCellStyle}>{item.quantity}</td>
                    <td style={tableCellStyle}>{formatCurrency(item.unitPrice)}</td>
                    <td style={tableCellStyle}>{formatCurrency(lineAmount(item))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
              <div>Subtotal {formatCurrency(billingPreview.subtotal)}</div>
              <div>Tax {formatCurrency(billingPreview.taxAmount)}</div>
              <div style={{ color: 'var(--accent)', fontWeight: 600, marginTop: '0.35rem' }}>
                Total {formatCurrency(billingPreview.total)}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

const sectionStyle: CSSProperties = {
  padding: '1rem',
  marginBottom: '1.5rem',
  border: '1px solid var(--border)',
  backgroundColor: 'var(--bg-secondary)',
};

const sectionHeaderStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '1rem',
  marginBottom: '1rem',
  flexWrap: 'wrap',
};

const rowCardStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '1rem',
  padding: '0.75rem',
  border: '1px solid var(--border)',
  backgroundColor: 'var(--bg-primary)',
  flexWrap: 'wrap',
};

const formGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: '1rem',
};

const tableHeadStyle: CSSProperties = {
  textAlign: 'left',
  color: 'var(--text-secondary)',
  fontWeight: 500,
  padding: '0.5rem 0.4rem',
  borderBottom: '1px solid var(--border)',
};

const tableCellStyle: CSSProperties = {
  padding: '0.4rem',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'middle',
};

const mutedStyle: CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: '0.85rem',
};
