import CustomSelect from '../../components/CustomSelect';
import { labelCls } from '../../components/texture-gen/constants';
import type { OpenRouterTextureControls } from './types';

export default function OpenRouterModelPicker({ model, setModel, models, error }: OpenRouterTextureControls) {
  return (
    <div className="col-span-2">
      <div className={labelCls}>Model</div>
      <CustomSelect
        value={model}
        onChange={setModel}
        options={models.length
          ? models.map((entry) => ({ value: entry.id, label: entry.label }))
          : [{ value: model, label: model || (error ? 'Models unavailable' : 'Loading models…') }]}
      />
      {error && <div className="mt-1 text-[10px] text-red-400">{error}</div>}
    </div>
  );
}
