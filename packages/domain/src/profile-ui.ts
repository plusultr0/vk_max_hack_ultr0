/**
 * Only inputs used by the current catalogue are required. Optional legacy fields
 * stay stored, editable and visible; they do not become invented rule conditions.
 */
export const INDUSTRY_VALUES = [
  'retail_non_food','retail_food','food_service','food_production','manufacturing','construction',
  'property_management','transport_logistics','hotels','beauty','healthcare','pharmacy','education','childcare',
  'fitness','tourism','it_software','advertising','banking_fintech','accounting','crop_farming','childrens_goods',
  'auto_service','security_services','waste_recycling','veterinary','industry_other'
] as const;

export const REQUIRED_PROFILE_FIELDS = ['legalForm','industry','taxRegime','sellsToConsumers','distanceSales','collectsPersonalData'] as const;
export const OPTIONAL_PROFILE_FIELDS = ['region','salesChannels','onlinePayment'] as const;

export function profileWarnings(data:Record<string,unknown>):string[] {
  const warnings:string[]=[];
  const channels=data.salesChannels;
  if(Array.isArray(channels)&&channels.length===0&&
    (data.sellsToConsumers===true||data.distanceSales===true||data.onlinePayment===true))
    warnings.push('Вы указали, что заказы пока не принимаете, но также указали продажи, дистанционные заказы или онлайн-оплату. Проверьте, что ответы описывают работу бизнеса сейчас. Сохранение доступно.');
  if(data.distanceSales===false&&Array.isArray(channels)&&channels.some(c=>['own_site','marketplace','social','messenger'].includes(c)))
    warnings.push('Вы указали заказы через интернет или сообщения и одновременно отсутствие дистанционных заказов. Проверьте эти ответы. Например, сайт может только знакомить с товарами, а заказ оформляется в магазине.');
  if(data.onlinePayment===false&&data.internetSettlement===true)
    warnings.push('Ранее вы указали фактические расчёты через интернет, а сейчас отметили, что онлайн-оплата недоступна. Уточните актуальные сведения об оплате в карточке требования.');
  return warnings;
}

export type ProfileChange={field:string;before:unknown;after:unknown;hadBefore:boolean;hasAfter:boolean};
export function profileChanges(before:Record<string,unknown>|null,after:Record<string,unknown>):ProfileChange[] {
  const ignored=new Set(['profileVersion','confirmedAt']);
  return [...new Set([...Object.keys(before??{}),...Object.keys(after)])].filter(k=>!ignored.has(k)).sort().flatMap(field=>{
    const hadBefore=Object.hasOwn(before??{},field),hasAfter=Object.hasOwn(after,field);
    const old=before?.[field],value=after[field];
    // Multi-selection order is not a business change.
    const normalized=(v:unknown)=>JSON.stringify(Array.isArray(v)?[...v].sort():v);
    return hadBefore===hasAfter&&normalized(old)===normalized(value)?[]:
      [{field,before:old??null,after:value??null,hadBefore,hasAfter}];
  });
}
